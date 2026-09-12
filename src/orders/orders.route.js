const express = require("express");
const cors = require("cors");
const Order = require("./orders.model");
const Products = require("../products/products.model"); // عدّل المسار إذا مختلف عندك
const verifyToken = require("../middleware/verifyToken");
const verifyAdmin = require("../middleware/verifyAdmin");
const router = express.Router();
const axios = require("axios");
require("dotenv").config();

const THAWANI_API_KEY = process.env.THAWANI_API_KEY;
const THAWANI_API_URL = process.env.THAWANI_API_URL;
const THAWANI_PUBLISH_KEY = process.env.THAWANI_PUBLISH_KEY;

const app = express();
app.use(cors({ origin: "https://www.chi-matcha.com" }));
app.use(express.json());

const ORDER_CACHE = new Map();

const toBaisa = (omr) => Math.max(100, Math.round(Number(omr || 0) * 1000));

const pairDiscountForProduct = (p) => {
  const isShayla = p.category === "الشيلات فرنسية" || p.category === "الشيلات سادة";
  if (!isShayla) return 0;
  const qty = Number(p.quantity || 0);
  const pairs = Math.floor(qty / 2);
  return pairs * 1;
};

const hasGiftValues = (gc) => {
  if (!gc || typeof gc !== "object") return false;
  const v = (x) => (x ?? "").toString().trim();
  return !!(v(gc.from) || v(gc.to) || v(gc.phone) || v(gc.note));
};

const normalizeGift = (gc) =>
  hasGiftValues(gc)
    ? {
        from: gc.from || "",
        to: gc.to || "",
        phone: gc.phone || "",
        note: gc.note || "",
      }
    : undefined;

const decreaseProductsQuantity = async (products = []) => {
  for (const item of products) {
    const productId = item.productId || item._id;
    const orderedQty = Math.max(1, Number(item.quantity || 1));

    const updatedProduct = await Products.findOneAndUpdate(
      {
        _id: productId,
        quantity: { $gte: orderedQty },
      },
      {
        $inc: { quantity: -orderedQty },
      },
      { new: true }
    );

    if (updatedProduct && updatedProduct.quantity <= 0) {
      updatedProduct.inStock = false;
      await updatedProduct.save();
    }
  }
};

router.post("/create-checkout-session", async (req, res) => {
  const {
    products,
    email,
    customerName,
    customerPhone,
    country,
    wilayat,
    description,
    depositMode,
    giftCard,
    gulfCountry,
    deliveryType,
    selectedArea,
    effectiveArea,
  } = req.body;

  const TWO_RIAL_HOME_AREAS = [
    "بوشر",
    "قريات",
    "المعبيلة",
    "العامرات",
    "الخوض",
    "مطرح",
    "السيب",

    "بركاء",
    "الخابورة",
    "الرستاق",
    "صحار",
    "صحم",
    "السويق",
    "لوى",
    "شناص",
    "المصنعة",
    "نخل",

    "سمد الشأن",
    "بدية",
    "إبراء",
    "سناو",
    "جعلان",
    "صور",

    "أدم",
    "سمائل",
    "إزكي",
    "بهلاء",
    "نزوى",
    "الحمراء",
    "منح",
    "فنجاء",

    "البريمي",
    "صلالة",
    "عبري",
    "ينقل",
  ];

  const THREE_RIAL_HOME_AREAS = [
    "مرمول",
    "الشويمية",
    "ثمريت",
    "المزيونة",
    "سدح",
    "حاسك",
    "شليم",

    "مصيرة",

    "هيما",
    "الدقم",
    "الجازر",
    "محوت",

    "خصب",
    "بخاء",
    "دبا",
  ];

  const OFFICE_AREAS = [
    ...TWO_RIAL_HOME_AREAS,
    "خصب",
  ];

  const normalizeArabic = (value = "") => {
    return String(value)
      .trim()
      .toLowerCase()
      .replace(/[أإآ]/g, "ا")
      .replace(/ى/g, "ي")
      .replace(/ة/g, "ه")
      .replace(/ؤ/g, "و")
      .replace(/ئ/g, "ي")
      .replace(/[\u064B-\u065F]/g, "")
      .replace(/\s+/g, " ");
  };

  const detectAreaFromAddress = (address) => {
    if (!address) return "";

    const normalizedAddress =
      normalizeArabic(address);

    const allAreas = [
      ...THREE_RIAL_HOME_AREAS,
      ...TWO_RIAL_HOME_AREAS,
    ];

    const foundArea =
      allAreas.find((area) =>
        normalizedAddress.includes(
          normalizeArabic(area)
        )
      );

    if (foundArea) {
      return foundArea;
    }

    if (
      normalizedAddress.includes("هيما") ||
      normalizedAddress.includes("هيماء")
    ) {
      return "هيما";
    }

    return "";
  };

  const detectedArea =
    detectAreaFromAddress(wilayat);

  const finalEffectiveArea =
    selectedArea ||
    effectiveArea ||
    detectedArea ||
    "";

  const selectedDeliveryType =
    country === "دول الخليج"
      ? ""
      : deliveryType === "مكتب"
      ? "مكتب"
      : "بيت";

  if (
    country !== "دول الخليج" &&
    selectedDeliveryType === "مكتب" &&
    !OFFICE_AREAS.includes(
      finalEffectiveArea
    )
  ) {
    return res.status(400).json({
      error:
        "الاستلام من المكتب غير متوفر في هذه المنطقة.",
    });
  }

  let shippingFee = 0;

  if (country === "دول الخليج") {
    shippingFee =
      gulfCountry === "الإمارات"
        ? 4
        : 5;
  } else if (
    selectedDeliveryType === "مكتب" &&
    OFFICE_AREAS.includes(
      finalEffectiveArea
    )
  ) {
    shippingFee = 1;
  } else if (
    selectedDeliveryType === "بيت" &&
    THREE_RIAL_HOME_AREAS.includes(
      finalEffectiveArea
    )
  ) {
    shippingFee = 3;
  } else {
    shippingFee = 2;
  }

  const DEPOSIT_AMOUNT_OMR = 10;

  const toSafeBaisa = (amount) => {
    const value = Number(amount);

    if (!Number.isFinite(value)) {
      return 100;
    }

    return Math.max(
      100,
      Math.round(value * 1000)
    );
  };

  const safeProductName = (
    name,
    fallback = "Product"
  ) => {
    const value = String(
      name || fallback
    ).trim();

    if (!value) {
      return fallback;
    }

    return value.slice(0, 40);
  };

  if (
    !Array.isArray(products) ||
    products.length === 0
  ) {
    return res.status(400).json({
      error:
        "Invalid or empty products array",
    });
  }

  if (products.length > 100) {
    return res.status(400).json({
      error:
        "عدد المنتجات أكبر من الحد المسموح.",
    });
  }

  try {
    for (const item of products) {
      const productId =
        item._id || item.productId;

      const orderedQty =
        Math.min(
          100,
          Math.max(
            1,
            Math.floor(
              Number(
                item.quantity || 1
              )
            )
          )
        );

      const productInDb =
        await Products.findById(
          productId
        );

      if (!productInDb) {
        return res.status(400).json({
          error: `المنتج غير موجود: ${
            item.name || ""
          }`,
        });
      }

      if (
        Number(
          productInDb.quantity || 0
        ) < orderedQty
      ) {
        return res.status(400).json({
          error: `الكمية غير متوفرة للمنتج: ${
            item.name || ""
          }`,
        });
      }
    }

    const productsSubtotal =
      products.reduce(
        (sum, p) => {
          const price =
            Number(p.price || 0);

          const quantity =
            Math.max(
              1,
              Number(
                p.quantity || 1
              )
            );

          return (
            sum +
            price * quantity
          );
        },
        0
      );

    const totalPairDiscount =
      products.reduce(
        (sum, p) =>
          sum +
          Number(
            pairDiscountForProduct(
              p
            ) || 0
          ),
        0
      );

    const subtotalAfterDiscount =
      Math.max(
        0,
        productsSubtotal -
          totalPairDiscount
      );

    const originalTotal =
      subtotalAfterDiscount +
      shippingFee;

    let lineItems = [];
    let amountToCharge = 0;

    if (depositMode) {
      lineItems = [
        {
          name: "دفعة مقدم",
          quantity: 1,
          unit_amount:
            toSafeBaisa(
              DEPOSIT_AMOUNT_OMR
            ),
        },
      ];

      amountToCharge =
        DEPOSIT_AMOUNT_OMR;
    } else {
      lineItems = products.map(
        (p) => {
          const unitBase =
            Number(
              p.price || 0
            );

          const qty =
            Math.min(
              100,
              Math.max(
                1,
                Math.floor(
                  Number(
                    p.quantity || 1
                  )
                )
              )
            );

          const productDiscount =
            Number(
              pairDiscountForProduct(
                p
              ) || 0
            );

          const unitAfterDiscount =
            Math.max(
              0.1,
              unitBase -
                productDiscount /
                  qty
            );

          return {
            name:
              safeProductName(
                p.name,
                "Product"
              ),

            quantity: qty,

            unit_amount:
              toSafeBaisa(
                unitAfterDiscount
              ),
          };
        }
      );

      lineItems.push({
        name: "رسوم الشحن",
        quantity: 1,
        unit_amount:
          toSafeBaisa(
            shippingFee
          ),
      });

      amountToCharge =
        originalTotal;
    }

    for (const item of lineItems) {
      if (
        !item.name ||
        item.name.length > 40 ||
        !Number.isInteger(
          item.quantity
        ) ||
        item.quantity < 1 ||
        item.quantity > 100 ||
        !Number.isInteger(
          item.unit_amount
        ) ||
        item.unit_amount < 100
      ) {
        console.error(
          "Invalid Thawani product:",
          item
        );

        return res
          .status(400)
          .json({
            error:
              "بيانات المنتج غير صالحة للدفع.",
            details: item,
          });
      }
    }

    const nowId =
      Date.now().toString();

    const orderPayload = {
      orderId: nowId,

      products:
        products.map((p) => ({
          productId:
            p._id ||
            p.productId,

          quantity:
            p.quantity,

          name:
            p.name,

          price:
            p.price,

          image:
            Array.isArray(
              p.image
            )
              ? p.image[0]
              : p.image,

          measurements:
            p.measurements || {},

          category:
            p.category || "",

          giftCard:
            normalizeGift(
              p.giftCard
            ) || undefined,
        })),

      amountToCharge,

      shippingFee,

      customerName,

      customerPhone,

      country,

      gulfCountry,

      deliveryType:
        selectedDeliveryType,

      selectedArea:
        selectedArea || "",

      effectiveArea:
        finalEffectiveArea,

      wilayat,

      description,

      email:
        email || "",

      status:
        "completed",

      depositMode:
        !!depositMode,

      remainingAmount:
        depositMode
          ? Math.max(
              0,
              originalTotal -
                DEPOSIT_AMOUNT_OMR
            )
          : 0,

      giftCard:
        normalizeGift(giftCard),
    };

    ORDER_CACHE.set(
      nowId,
      orderPayload
    );

    const thawaniData = {
      client_reference_id:
        String(nowId),

      mode:
        "payment",

      products:
        lineItems,

      success_url:
        "https://www.chi-matcha.com/SuccessRedirect?client_reference_id=" +
        nowId,

      cancel_url:
        "https://www.chi-matcha.com/cancel",

      metadata: {
        order_id:
          String(nowId),

        customer_name:
          String(
            customerName || ""
          ).slice(0, 100),

        customer_phone:
          String(
            customerPhone || ""
          ).slice(0, 30),

        customer_email:
          String(
            email || ""
          ).slice(0, 100),
      },
    };

    console.log(
      "THAWANI REQUEST:",
      JSON.stringify(
        thawaniData,
        null,
        2
      )
    );

    const response =
      await axios.post(
        `${THAWANI_API_URL}/checkout/session`,
        thawaniData,
        {
          headers: {
            "Content-Type":
              "application/json",

            "thawani-api-key":
              THAWANI_API_KEY,
          },

          timeout: 30000,
        }
      );

    console.log(
      "THAWANI RESPONSE:",
      response.data
    );

    const sessionId =
      response?.data?.data
        ?.session_id;

    if (!sessionId) {
      ORDER_CACHE.delete(
        nowId
      );

      return res
        .status(500)
        .json({
          error:
            "No session_id returned from Thawani",

          details:
            response?.data,
        });
    }

    const paymentLink =
      `https://uatcheckout.thawani.om/pay/${sessionId}?key=${THAWANI_PUBLISH_KEY}`;

    return res.json({
      id: sessionId,
      paymentLink,
    });
  } catch (error) {
    console.error(
      "THAWANI ERROR STATUS:",
      error?.response?.status
    );

    console.error(
      "THAWANI ERROR DATA:",
      JSON.stringify(
        error?.response?.data ||
          {},
        null,
        2
      )
    );

    console.error(
      "THAWANI ERROR MESSAGE:",
      error.message
    );

    return res.status(500).json({
      error:
        error?.response?.data
          ?.description ||
        "Failed to create checkout session",

      details:
        error?.response?.data ||
        error.message,
    });
  }
});
router.post("/confirm-payment", async (req, res) => {
  const { client_reference_id } = req.body;

  if (!client_reference_id) {
    return res.status(400).json({ error: "Session ID is required" });
  }

  try {
    const sessionsResponse = await axios.get(
      `${THAWANI_API_URL}/checkout/session/?limit=20&skip=0`,
      {
        headers: {
          "Content-Type": "application/json",
          "thawani-api-key": THAWANI_API_KEY,
        },
      }
    );

    const sessions = sessionsResponse?.data?.data || [];
    const sessionSummary = sessions.find(
      (s) => s.client_reference_id === client_reference_id
    );

    if (!sessionSummary) {
      return res.status(404).json({ error: "Session not found" });
    }

    const session_id = sessionSummary.session_id;

    const response = await axios.get(
      `${THAWANI_API_URL}/checkout/session/${session_id}?limit=1&skip=0`,
      {
        headers: {
          "Content-Type": "application/json",
          "thawani-api-key": THAWANI_API_KEY,
        },
      }
    );

    const session = response?.data?.data;

    if (!session || session.payment_status !== "paid") {
      return res
        .status(400)
        .json({ error: "Payment not successful or session not found" });
    }

    const meta = session?.metadata || session?.meta_data || {};
    const metaCustomerName = meta.customer_name || "";
    const metaCustomerPhone = meta.customer_phone || "";
    const metaEmail = meta.email || "";
    const metaCountry = meta.country || "";
    const metaWilayat = meta.wilayat || "";
    const metaDescription = meta.description || "";
    const metaShippingFee =
      typeof meta.shippingFee !== "undefined" ? Number(meta.shippingFee) : undefined;

    let order = await Order.findOne({ orderId: client_reference_id });
    const isNewOrder = !order;

    const paidAmountOMR = Number(session.total_amount || 0) / 1000;
    const cached = ORDER_CACHE.get(client_reference_id) || {};

    const productsFromCache = Array.isArray(cached.products)
      ? cached.products.map((p) => {
          const giftCard = normalizeGift(p.giftCard);

          return {
            productId: p.productId || p._id,
            quantity: p.quantity,
            name: p.name,
            price: p.price,
            image: Array.isArray(p.image) ? p.image[0] : p.image,
            category: p.category || "",
            measurements: p.measurements || {},
            giftCard,
          };
        })
      : [];

    const resolvedShippingFee = (() => {
      if (typeof metaShippingFee !== "undefined") return metaShippingFee;
      if (typeof cached.shippingFee !== "undefined") return Number(cached.shippingFee);

      const country = (cached.country || metaCountry || "").trim();
      const gulfCountryFromMeta = (meta.gulfCountry || meta.gulf_country || "").trim();

      if (country === "دول الخليج") {
        return gulfCountryFromMeta === "الإمارات" ? 4 : 5;
      }

      return cached.deliveryType === "مكتب" ? 1 : 2;
    })();

    if (!order) {
      const orderLevelGift = normalizeGift(cached.giftCard);

      order = new Order({
        orderId: cached.orderId || client_reference_id,
        products: productsFromCache,
        amount: paidAmountOMR,
        shippingFee: resolvedShippingFee,
        customerName: cached.customerName || metaCustomerName,
        customerPhone: cached.customerPhone || metaCustomerPhone,
        country: cached.country || metaCountry,
        wilayat: cached.wilayat || metaWilayat,
        description: cached.description || metaDescription,
        email: cached.email || metaEmail,
        status: "completed",
        depositMode: !!cached.depositMode,
        remainingAmount: Number(cached.remainingAmount || 0),
        giftCard: orderLevelGift,
      });
    } else {
      order.status = "completed";
      order.amount = paidAmountOMR;

      if (!order.customerName && metaCustomerName) order.customerName = metaCustomerName;
      if (!order.customerPhone && metaCustomerPhone) order.customerPhone = metaCustomerPhone;
      if (!order.country && metaCountry) order.country = metaCountry;
      if (!order.wilayat && metaWilayat) order.wilayat = metaWilayat;
      if (!order.description && metaDescription) order.description = metaDescription;
      if (!order.email && metaEmail) order.email = metaEmail;

      if (order.shippingFee === undefined || order.shippingFee === null) {
        order.shippingFee = resolvedShippingFee;
      }

      if (productsFromCache.length > 0) {
        order.products = productsFromCache;
      }

      if (!hasGiftValues(order.giftCard) && hasGiftValues(cached.giftCard)) {
        order.giftCard = normalizeGift(cached.giftCard);
      }
    }

    order.paymentSessionId = session_id;
    order.paidAt = new Date();

    await order.save();

    if (isNewOrder && productsFromCache.length > 0) {
      await decreaseProductsQuantity(productsFromCache);
    }

    ORDER_CACHE.delete(client_reference_id);

    res.json({ order });
  } catch (error) {
    console.error("Error confirming payment:", error?.response?.data || error);

    res.status(500).json({
      error: "Failed to confirm payment",
      details: error?.response?.data || error.message,
    });
  }
});

router.get("/order-with-products/:orderId", async (req, res) => {
  try {
    const order = await Order.findById(req.params.orderId);

    if (!order) return res.status(404).json({ error: "Order not found" });

    const products = await Promise.all(
      order.products.map(async (item) => {
        const product = await Products.findById(item.productId);

        if (!product) {
          return {
            productId: item.productId,
            quantity: item.quantity,
            name: item.name,
            price: item.price,
            image: item.image,
          };
        }

        return {
          ...product.toObject(),
          quantity: item.quantity,
          selectedSize: item.selectedSize,
          price: product.price,
        };
      })
    );

    res.json({ order, products });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/:email", async (req, res) => {
  const email = req.params.email;

  if (!email) {
    return res.status(400).send({ message: "Email is required" });
  }

  try {
    const orders = await Order.find({ email: email });

    if (orders.length === 0) {
      return res.status(404).send({ message: "No orders found for this email" });
    }

    res.status(200).send({ orders });
  } catch (error) {
    console.error("Error fetching orders by email:", error);
    res.status(500).send({ message: "Failed to fetch orders by email" });
  }
});

router.get("/order/:id", async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);

    if (!order) {
      return res.status(404).send({ message: "Order not found" });
    }

    res.status(200).send(order);
  } catch (error) {
    console.error("Error fetching orders by user id", error);
    res.status(500).send({ message: "Failed to fetch orders by user id" });
  }
});

router.get("/", async (req, res) => {
  try {
    const orders = await Order.find({ status: "completed" }).sort({ createdAt: -1 });

    if (orders.length === 0) {
      return res.status(404).send({ message: "No orders found", orders: [] });
    }

    res.status(200).send(orders);
  } catch (error) {
    console.error("Error fetching all orders", error);
    res.status(500).send({ message: "Failed to fetch all orders" });
  }
});

router.patch("/update-order-status/:id", async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  if (!status) {
    return res.status(400).send({ message: "Status is required" });
  }

  try {
    const updatedOrder = await Order.findByIdAndUpdate(
      id,
      {
        status,
        updatedAt: new Date(),
      },
      {
        new: true,
        runValidators: true,
      }
    );

    if (!updatedOrder) {
      return res.status(404).send({ message: "Order not found" });
    }

    res.status(200).json({
      message: "Order status updated successfully",
      order: updatedOrder,
    });
  } catch (error) {
    console.error("Error updating order status", error);
    res.status(500).send({ message: "Failed to update order status" });
  }
});

router.delete("/delete-order/:id", async (req, res) => {
  const { id } = req.params;

  try {
    const deletedOrder = await Order.findByIdAndDelete(id);

    if (!deletedOrder) {
      return res.status(404).send({ message: "Order not found" });
    }

    res.status(200).json({
      message: "Order deleted successfully",
      order: deletedOrder,
    });
  } catch (error) {
    console.error("Error deleting order", error);
    res.status(500).send({ message: "Failed to delete order" });
  }
});

module.exports = router;