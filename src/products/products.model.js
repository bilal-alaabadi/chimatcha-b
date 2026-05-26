const mongoose = require("mongoose");

const ProductSchema = new mongoose.Schema(
  {
    name:        { type: String, required: true },   // سيتم تخزينه كـ "الاسم (الحجم)" عند وجود حجم
    size:        { type: String, default: null },    // اختياري: الحجم الأصلي مستقل
    category:    { type: String, required: true },
    description: { type: String, required: true },
    price:       { type: Number, required: true },
    image:       { type: [String], required: true },
    oldPrice:    { type: Number },
    rating:      { type: Number, default: 0 },
    author:      { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    inStock:     { type: Boolean, default: true },
  },
  { timestamps: true }
);

const Products = mongoose.model("Product", ProductSchema);
module.exports = Products;
