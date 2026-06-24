const fs = require("fs");
const path = require("path");

const dataFile = path.join(__dirname, "reviews.json");

if (!fs.existsSync(dataFile)) {
    fs.writeFileSync(dataFile, "[]");
}

function getReviews() {
    try {
        const data = fs.readFileSync(dataFile, "utf8");
        return JSON.parse(data);
    } catch (error) {
        return [];
    }
}

function saveReview(review) {
    const reviews = getReviews();
    review.id = Date.now().toString();
    review.createdAt = new Date().toISOString();
    // Ensure new fields exist with defaults
    review.recommend = review.recommend || null;
    review.yearFrom = review.yearFrom || null;
    review.yearTo = review.yearTo || null;
    reviews.push(review);
    fs.writeFileSync(dataFile, JSON.stringify(reviews, null, 2));
    return review;
}

module.exports = { getReviews, saveReview };

function updateReview(reviewId, updatedData) {
    const reviews = getReviews();
    const index = reviews.findIndex(r => r.id.toString() === reviewId.toString());
    if (index === -1) return null;
    
    reviews[index] = { ...reviews[index], ...updatedData, lastEditedAt: new Date().toISOString() };
    fs.writeFileSync(dataFile, JSON.stringify(reviews, null, 2));
    return reviews[index];
}

function deleteReview(reviewId) {
    const reviews = getReviews();
    const filtered = reviews.filter(r => r.id.toString() !== reviewId.toString());
    fs.writeFileSync(dataFile, JSON.stringify(filtered, null, 2));
    return true;
}

module.exports = { getReviews, saveReview, updateReview, deleteReview };
