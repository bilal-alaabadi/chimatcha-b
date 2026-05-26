// ====================== src/products/products.route.js (كامل) ======================
const express = require("express");
const Products = require("./products.model");
const Reviews = require("../reviews/reviews.model");
const verifyToken = require("../middleware/verifyToken");
const verifyAdmin = require("../middleware/verifyAdmin");
const router = express.Router();

const { uploadImages, uploadBufferToCloudinary } = require("../utils/uploadImage");

// (اختياري) رفع Base64 عبر هذا الراوت داخل منتجات
router.post("/uploadImages", async (req, res) => {
  try {
    const { images } = req.body; // مصفوفة Base64/DataURL
    if (!images || !Array.isArray(images)) {
      return res.status(400).send({ message: "يجب إرسال مصفوفة من الصور" });
    }
    const uploadedUrls = await uploadImages(images);
    res.status(200).send(uploadedUrls);
  } catch (error) {
    console.error("Error uploading images:", error);
    res.status(500).send({ message: "حدث خطأ أثناء تحميل الصور" });
  }
});

// إنشاء منتج
// مثال داخل products.route.js (أو الملف الذي يحوي الراوت)
router.post("/create-product", async (req, res) => {
  try {
    const {
      name,
      size,          // اختياري
      category,
      description,
      oldPrice,
      price,
      image,
      author,
      inStock
    } = req.body;

    if (!name || !category || !description || !price || !image || !author) {
      return res.status(400).send({ message: "جميع الحقول المطلوبة يجب إرسالها" });
    }

    // تكوين الاسم النهائي: إذا وُجد حجم → "الاسم (الحجم)"
    const finalName = size && String(size).trim()
      ? `${name} (${String(size).trim()})`
      : name;

    const productData = {
      name: finalName,
      size: size || null,              // نخزن الحجم أيضاً بشكل مستقل
      category,
      description,
      price,
      oldPrice,
      image,
      author,
      inStock: typeof inStock === 'boolean' ? inStock : true
    };

    const newProduct = new Products(productData);
    const savedProduct = await newProduct.save();

    res.status(201).send(savedProduct);
  } catch (error) {
    console.error("Error creating new product", error);
    res.status(500).send({ message: "Failed to create new product" });
  }
});



// جميع المنتجات
router.get("/", async (req, res) => {
  try {
    const {
      category,
      size,
      color,
      minPrice,
      maxPrice,
      page = 1,
      limit = 10,
    } = req.query;

    const filter = {};

    if (category && category !== "all") {
      filter.category = category;
      if (category === "حناء بودر" && size) {
        filter.size = size;
      }
    }

    if (color && color !== "all") filter.color = color;

    if (minPrice && maxPrice) {
      const min = parseFloat(minPrice);
      const max = parseFloat(maxPrice);
      if (!isNaN(min) && !isNaN(max)) {
        filter.price = { $gte: min, $lte: max };
      }
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const totalProducts = await Products.countDocuments(filter);
    const totalPages = Math.ceil(totalProducts / parseInt(limit));

    const products = await Products.find(filter)
      .skip(skip)
      .limit(parseInt(limit))
      .populate("author", "email")
      .sort({ createdAt: -1 });

    res.status(200).send({ products, totalPages, totalProducts });
  } catch (error) {
    console.error("Error fetching products:", error);
    res.status(500).send({ message: "Failed to fetch products" });
  }
});

// منتج واحد (يدعم مسارين)
router.get(["/:id", "/product/:id"], async (req, res) => {
  try {
    const productId = req.params.id;
    const product = await Products.findById(productId).populate("author", "email username");
    if (!product) {
      return res.status(404).send({ message: "Product not found" });
    }
    const reviews = await Reviews.find({ productId }).populate("userId", "username email");
    res.status(200).send({ product, reviews });
  } catch (error) {
    console.error("Error fetching the product", error);
    res.status(500).send({ message: "Failed to fetch the product" });
  }
});

// تحديث منتج (إظهار/حذف صور حالية + إضافة صور جديدة)
const multer = require("multer");
const storage = multer.memoryStorage();
const upload = multer({ storage });

router.patch(
  "/update-product/:id",
  verifyToken,
  verifyAdmin,
  upload.array("image"),
  async (req, res) => {
    try {
      const productId = req.params.id;

      const productExists = await Products.findById(productId);
      if (!productExists) {
        return res.status(404).send({ message: "المنتج غير موجود" });
      }

      // تنظيف الاسم من أي حجم قديم في آخره: "اسم (شيء)"
      const rawName = typeof req.body.name === 'string' ? req.body.name : '';
      const baseName = rawName.replace(/\s*\([^)]*\)\s*$/g, '').trim();

      const size = typeof req.body.size === 'string' ? req.body.size.trim() : '';
      const finalName = size ? `${baseName} (${size})` : baseName;

      // inStock قد تأتي كـ "true"/"false" أو Boolean
      const inStockRaw = req.body.inStock;
      const inStock =
        typeof inStockRaw === 'boolean'
          ? inStockRaw
          : String(inStockRaw).toLowerCase() === 'true';

      const updateData = {
        name: finalName,
        category: req.body.category,
        price: req.body.price,
        oldPrice: req.body.oldPrice || null,
        description: req.body.description,
        size: size || null,
        author: req.body.author,
        inStock,
      };

      if (!updateData.name || !updateData.category || !updateData.price || !updateData.description) {
        return res.status(400).send({ message: "جميع الحقول المطلوبة يجب إرسالها" });
      }
      if (updateData.category === "حناء بودر" && !updateData.size) {
        return res.status(400).send({ message: "يجب تحديد حجم الحناء" });
      }

      // keepImages مُرسلة من الواجهة كنص JSON
      let keepImages = [];
      if (typeof req.body.keepImages === "string" && req.body.keepImages.trim() !== "") {
        try {
          const parsed = JSON.parse(req.body.keepImages);
          if (Array.isArray(parsed)) keepImages = parsed;
        } catch (_) {
          keepImages = [];
        }
      }

      // رفع الصور الجديدة (إن وُجدت)
      let newImageUrls = [];
      if (Array.isArray(req.files) && req.files.length > 0) {
        newImageUrls = await Promise.all(
          req.files.map((file) => uploadBufferToCloudinary(file.buffer, "products"))
        );
      }

      if (keepImages.length > 0 || newImageUrls.length > 0) {
        updateData.image = [...keepImages, ...newImageUrls];
      } else {
        delete updateData.image; // لا نلمس الصور إن لم تُرسل
      }

      const updatedProduct = await Products.findByIdAndUpdate(
        productId,
        { $set: updateData },
        { new: true, runValidators: true }
      );

      if (!updatedProduct) {
        return res.status(404).send({ message: "المنتج غير موجود" });
      }

      res.status(200).send({
        message: "تم تحديث المنتج بنجاح",
        product: updatedProduct,
      });
    } catch (error) {
      console.error("خطأ في تحديث المنتج", error);
      res.status(500).send({
        message: "فشل تحديث المنتج",
        error: error.message,
      });
    }
  }
);

// حذف منتج
router.delete("/:id", async (req, res) => {
  try {
    const productId = req.params.id;
    const deletedProduct = await Products.findByIdAndDelete(productId);

    if (!deletedProduct) {
      return res.status(404).send({ message: "Product not found" });
    }

    await Reviews.deleteMany({ productId });
    res.status(200).send({ message: "Product deleted successfully" });
  } catch (error) {
    console.error("Error deleting the product", error);
    res.status(500).send({ message: "Failed to delete the product" });
  }
});

// منتجات ذات صلة
router.get("/related/:id", async (req, res) => {
  try {
    const { id } = req.params;
    if (!id) return res.status(400).send({ message: "Product ID is required" });

    const product = await Products.findById(id);
    if (!product) return res.status(404).send({ message: "Product not found" });

    const titleRegex = new RegExp(
      product.name.split(" ").filter((w) => w.length > 1).join("|"),
      "i"
    );

    const relatedProducts = await Products.find({
      _id: { $ne: id },
      $or: [{ name: { $regex: titleRegex } }, { category: product.category }],
    });

    res.status(200).send(relatedProducts);
  } catch (error) {
    console.error("Error fetching the related products", error);
    res.status(500).send({ message: "Failed to fetch related products" });
  }
});

module.exports = router;
