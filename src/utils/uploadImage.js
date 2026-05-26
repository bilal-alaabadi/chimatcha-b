// =========================== src/utils/uploadImage.js ===========================
const cloudinary = require("cloudinary").v2;
require("dotenv").config();

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const opts = {
  overwrite: false,
  invalidate: true,
  resource_type: "image",
  folder: "products",
};

// يحدد هل النص Data URL صالح (ببادئة data:...;base64,)
function isDataUrl(str) {
  return typeof str === "string" && /^data:[^;]+;base64,/.test(str);
}

// رفع صورة واحدة (Data URL أو Base64 خام) -> رابط
function uploadImage(image) {
  return new Promise((resolve, reject) => {
    if (!image) return reject({ message: "No image provided" });

    const fileParam = isDataUrl(image)
      ? image
      : `data:image/jpeg;base64,${image}`;

    cloudinary.uploader.upload(fileParam, opts, (error, result) => {
      if (error) return reject({ message: error.message });
      if (result && result.secure_url) return resolve(result.secure_url);
      return reject({ message: "Failed to upload image" });
    });
  });
}

// رفع مصفوفة Base64/DataURL -> مصفوفة روابط
async function uploadImages(images) {
  const list = Array.isArray(images) ? images : [];
  const clean = list.filter(Boolean).map(String).filter(s => s.length > 0);
  if (clean.length === 0) return [];
  return Promise.all(clean.map(uploadImage));
}

// رفع Buffer (multer.memoryStorage) عبر upload_stream -> رابط
function uploadBufferToCloudinary(buffer, folder = "products") {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder, resource_type: "image", invalidate: true, overwrite: false },
      (error, result) => {
        if (error) return reject(error);
        return resolve(result.secure_url);
      }
    );
    stream.end(buffer);
  });
}

module.exports = uploadImage; // التصدير الافتراضي (متوافق مع /uploadImage)
module.exports.uploadImage = uploadImage;
module.exports.uploadImages = uploadImages;
module.exports.uploadBufferToCloudinary = uploadBufferToCloudinary;
