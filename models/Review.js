const mongoose = require("mongoose");

// Connect to MongoDB (we will use a local database for now)
mongoose.connect("mongodb://localhost:27017/schoolsentiment", {
    useNewUrlParser: true,
    useUnifiedTopology: true
});

// Create Review Schema
const reviewSchema = new mongoose.Schema({
    schoolName: { type: String, required: true },
    userType: { type: String, required: true },
    rating: { type: Number, required: true, min: 1, max: 5 },
    reviewText: { type: String, required: true },
    isAnonymous: { type: Boolean, default: true },
    createdAt: { type: Date, default: Date.now },
    ipAddress: { type: String } // For basic spam protection
});

const Review = mongoose.model("Review", reviewSchema);

module.exports = Review;
