const express = require("express");
const cors = require("cors");
const Order = require("./orders.model");
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

// Create checkout session
// ========================= routes/orders.js (create-checkout-session) =========================
// ===== Helpers =====
// ========================= routes/create-checkout-session (نهائي) =========================
const ORDER_CACHE = new Map(); // key: client_reference_id -> value: orderPayload

// ===== Helpers =====
const toBaisa = (omr) => Math.max(100, Math.round(Number(omr || 0) * 1000)); // >= 100 بيسة

// خصم الأزواج للشيلات (ر.ع.)
const pairDiscountForProduct = (p) => {
  const isShayla = p.category === "الشيلات فرنسية" || p.category === "الشيلات سادة";
  if (!isShayla) return 0;
  const qty = Number(p.quantity || 0);
  const pairs = Math.floor(qty / 2);
  return pairs * 1; // 1 ر.ع لكل زوج
};

// هل تحتوي بطاقة الهدية على أي قيمة؟
const hasGiftValues = (gc) => {
  if (!gc || typeof gc !== "object") return false;
  const v = (x) => (x ?? "").toString().trim();
  return !!(v(gc.from) || v(gc.to) || v(gc.phone) || v(gc.note));
};

// تطبيع بطاقة الهدية إلى شكل ثابت
const normalizeGift = (gc) =>
  hasGiftValues(gc)
    ? {
        from: gc.from || "",
        to: gc.to || "",
        phone: gc.phone || "",
        note: gc.note || "",
      }
    : undefined;

// ========================= create-checkout-session =========================
router.post("/create-checkout-session", async (req, res) => {
  const {
    products,
    email,
    customerName,
    customerPhone,
    country,
    wilayat,
    description,
    depositMode, // إذا true: المقدم 10 ر.ع (من ضمنه التوصيل)
    giftCard,    // { from, to, phone, note } اختياري (على مستوى الطلب)
    gulfCountry, // الدولة المختارة داخل "دول الخليج" (إن وُجدت)
  } = req.body;

  // رسوم الشحن (ر.ع.)
  const shippingFee =
    country === "دول الخليج"
      ? (gulfCountry === "الإمارات" ? 4 : 5)
      : 2;

  const DEPOSIT_AMOUNT_OMR = 10; // المقدم الثابت

  if (!Array.isArray(products) || products.length === 0) {
    return res.status(400).json({ error: "Invalid or empty products array" });
  }

  try {
    // المجاميع كما في Checkout.jsx
    const productsSubtotal = products.reduce(
      (sum, p) => sum + Number(p.price || 0) * Number(p.quantity || 0),
      0
    );
    const totalPairDiscount = products.reduce(
      (sum, p) => sum + pairDiscountForProduct(p),
      0
    );
    const subtotalAfterDiscount = Math.max(0, productsSubtotal - totalPairDiscount);
    const originalTotal = subtotalAfterDiscount + shippingFee;

    let lineItems = [];
    let amountToCharge = 0;

    if (depositMode) {
      // دفعة مقدم 10 ر.ع (من ضمنه التوصيل)
      lineItems = [
        { name: "دفعة مقدم", quantity: 1, unit_amount: toBaisa(DEPOSIT_AMOUNT_OMR) },
      ];
      amountToCharge = DEPOSIT_AMOUNT_OMR;
    } else {
      // توزيع خصم الشيلات داخل سعر الوحدة لكل منتج
      lineItems = products.map((p) => {
        const unitBase = Number(p.price || 0);
        const qty = Math.max(1, Number(p.quantity || 1));
        const productDiscount = pairDiscountForProduct(p);
        const unitAfterDiscount = Math.max(0.1, unitBase - productDiscount / qty); // لا يقل عن 0.100
        return {
          name: String(p.name || "منتج"),
          quantity: qty,
          unit_amount: toBaisa(unitAfterDiscount),
        };
      });

      // بند الشحن كبند مستقل
      lineItems.push({
        name: "رسوم الشحن",
        quantity: 1,
        unit_amount: toBaisa(shippingFee),
      });

      amountToCharge = originalTotal;
    }

    const nowId = Date.now().toString();

    // حمولة الطلب الكاملة التي سنحفظها لاحقًا بعد نجاح الدفع فقط
    const orderPayload = {
      orderId: nowId,
      products: products.map((p) => ({
        productId: p._id,
        quantity: p.quantity,
        name: p.name,
        price: p.price, // ر.ع.
        image: Array.isArray(p.image) ? p.image[0] : p.image,
        measurements: p.measurements || {},
        category: p.category || "",
        // ✅ بطاقة الهدية على مستوى "كل منتج"
        giftCard: normalizeGift(p.giftCard) || undefined,
      })),
      amountToCharge,            // ما يُتوقع دفعه الآن
      shippingFee,               // محفوظ للحسابات
      customerName,
      customerPhone,
      country,
      wilayat,
      description,
      email: email || "",
      status: "completed",       // سيُحفظ فعليًا عند النجاح فقط
      depositMode: !!depositMode,
      remainingAmount: depositMode ? Math.max(0, originalTotal - DEPOSIT_AMOUNT_OMR) : 0,
      // ✅ إبقاء الحقل العام للتوافق — سيتم استخدامه فقط إذا لم توضع بطاقات على مستوى المنتجات
      giftCard: normalizeGift(giftCard),
    };

    // نخزّن الحمولة مؤقتًا في الذاكرة بدل metadata الكبيرة
    ORDER_CACHE.set(nowId, orderPayload);

    // نرسل لثواني فقط Meta خفيفة
    const data = {
      client_reference_id: nowId,
      mode: "payment",
      products: lineItems,
      success_url: "https://www.chi-matcha.com/SuccessRedirect?client_reference_id=" + nowId,
      cancel_url: "https://www.chi-matcha.com/cancel",
      metadata: {
        email: String(email || "غير محدد"),
        customer_name: String(customerName || ""),
        customer_phone: String(customerPhone || ""),
        country: String(country || ""),
        wilayat: String(wilayat || ""),
        description: String(description || "لا يوجد وصف"),
        shippingFee: String(shippingFee),
        internal_order_id: String(nowId),
        source: "mern-backend",
      },
    };

    const response = await axios.post(`${THAWANI_API_URL}/checkout/session`, data, {
      headers: {
        "Content-Type": "application/json",
        "thawani-api-key": THAWANI_API_KEY,
      },
    });

    const sessionId = response?.data?.data?.session_id;
    if (!sessionId) {
      ORDER_CACHE.delete(nowId); // تنظيف لو فشل الإنشاء
      return res.status(500).json({
        error: "No session_id returned from Thawani",
        details: response?.data,
      });
    }

    const paymentLink = `https://checkout.thawani.om/pay/${sessionId}?key=${THAWANI_PUBLISH_KEY}`;

    // لا نحفظ في القاعدة هنا
    res.json({ id: sessionId, paymentLink });
  } catch (error) {
    console.error("Error creating checkout session:", error?.response?.data || error);
    res.status(500).json({
      error: "Failed to create checkout session",
      details: error?.response?.data || error.message,
    });
  }
});


// في ملف routes/orders.js
router.get('/order-with-products/:orderId', async (req, res) => {
    try {
        const order = await Order.findById(req.params.orderId);
        if (!order) return res.status(404).json({ error: 'Order not found' });

        const products = await Promise.all(order.products.map(async item => {
            const product = await Product.findById(item.productId);
            return {
                ...product.toObject(),
                quantity: item.quantity,
                selectedSize: item.selectedSize,
                price: calculateProductPrice(product, item.quantity, item.selectedSize)
            };
        }));

        res.json({ order, products });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

function calculateProductPrice(product, quantity, selectedSize) {
    if (product.category === 'حناء بودر' && selectedSize && product.price[selectedSize]) {
        return (product.price[selectedSize] * quantity).toFixed(2);
    }
    return (product.regularPrice * quantity).toFixed(2);
}

// ========================= routes/orders.js (confirm-payment) =========================
// ========================= routes/confirm-payment (نهائي) =========================
router.post("/confirm-payment", async (req, res) => {
  const { client_reference_id } = req.body;

  if (!client_reference_id) {
    return res.status(400).json({ error: "Session ID is required" });
  }

  // Helpers محليّة للتطبيع
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

  try {
    // 1) جلب قائمة الجلسات ثم إيجاد الجلسة بالـ client_reference_id
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

    // 2) تفاصيل الجلسة
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

    // 3) ميتاداتا خفيفة
    const meta = session?.metadata || session?.meta_data || {};
    const metaCustomerName = meta.customer_name || "";
    const metaCustomerPhone = meta.customer_phone || "";
    const metaEmail = meta.email || "";
    const metaCountry = meta.country || "";
    const metaWilayat = meta.wilayat || "";
    const metaDescription = meta.description || "";
    const metaShippingFee =
      typeof meta.shippingFee !== "undefined" ? Number(meta.shippingFee) : undefined;

    // 4) احتمال وجود طلب سابق
    let order = await Order.findOne({ orderId: client_reference_id });

    // المبلغ المدفوع فعليًا (من ثواني) بالريال
    const paidAmountOMR = Number(session.total_amount || 0) / 1000;

    // نجلب الكاش
    const cached = ORDER_CACHE.get(client_reference_id) || {};

    // تطبيع المنتجات من الكاش مع تضمين بطاقة الهدية على مستوى كل منتج
    // ملاحظة: لا نُنشئ بطاقات وهمية؛ فقط نحترم الموجود في كل عنصر.
    const productsFromCache = Array.isArray(cached.products)
      ? cached.products.map((p) => {
          const giftCard = normalizeGift(p.giftCard); // إن وُجدت على مستوى المنتج
          return {
            productId: p.productId || p._id,
            quantity: p.quantity,
            name: p.name,
            price: p.price, // ر.ع.
            image: Array.isArray(p.image) ? p.image[0] : p.image,
            category: p.category || "",
            measurements: p.measurements || {},
            giftCard, // <-- تُحفظ فقط إن كانت موجودة فعلاً
          };
        })
      : [];

    // fallback ذكي لرسوم الشحن إذا لم تتوفر
    const resolvedShippingFee = (() => {
      if (typeof metaShippingFee !== "undefined") return metaShippingFee;
      if (typeof cached.shippingFee !== "undefined") return Number(cached.shippingFee);
      const country = (cached.country || metaCountry || "").trim();
      const gulfCountryFromMeta = (meta.gulfCountry || meta.gulf_country || "").trim();
      if (country === "دول الخليج") {
        return gulfCountryFromMeta === "الإمارات" ? 4 : 5; // ر.ع
      }
      return 2; // ر.ع داخل عُمان
    })();

    // 5) أنشئ/حدّث الطلب
    if (!order) {
      const orderLevelGift = normalizeGift(cached.giftCard);

      order = new Order({
        orderId: cached.orderId || client_reference_id,
        products: productsFromCache, // <-- كل منتج يحتفظ ببطاقة هديته إن وُجدت
        amount: paidAmountOMR, // المدفوع فعليًا
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
        giftCard: orderLevelGift, // (اختياري) الحقل العام
      });
    } else {
      // تحديث الطلب الموجود
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

      // لو لدينا منتجات من الكاش (الأحدث)، نُحدّث قائمة المنتجات كاملة
      if (productsFromCache.length > 0) {
        order.products = productsFromCache;
      }

      // نطبّع البطاقة العامة إن كانت غير محفوظة
      if (!hasGiftValues(order.giftCard) && hasGiftValues(cached.giftCard)) {
        order.giftCard = normalizeGift(cached.giftCard);
      }
    }

    // تخزين session_id ووقت الدفع
    order.paymentSessionId = session_id;
    order.paidAt = new Date();

    await order.save();

    // تنظيف الكاش بعد الحفظ
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


// Get order by email
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

// get order by id
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

// get all orders
router.get("/", async (req, res) => {
    try {
        const orders = await Order.find({status:"completed"}).sort({ createdAt: -1 });
        if (orders.length === 0) {
            return res.status(404).send({ message: "No orders found", orders: [] });
        }

        res.status(200).send(orders);
    } catch (error) {
        console.error("Error fetching all orders", error);
        res.status(500).send({ message: "Failed to fetch all orders" });
    }
});

// update order status
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
            order: updatedOrder
        });

    } catch (error) {
        console.error("Error updating order status", error);
        res.status(500).send({ message: "Failed to update order status" });
    }
});

// delete order
router.delete('/delete-order/:id', async (req, res) => {
    const { id } = req.params;

    try {
        const deletedOrder = await Order.findByIdAndDelete(id);
        if (!deletedOrder) {
            return res.status(404).send({ message: "Order not found" });
        }
        res.status(200).json({
            message: "Order deleted successfully",
            order: deletedOrder
        });

    } catch (error) {
        console.error("Error deleting order", error);
        res.status(500).send({ message: "Failed to delete order" });
    }
});

module.exports = router;
