const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const adsFile = path.join(__dirname, "noticeboard_ads.json");

function generatePublicId() {
    // Format: SS- followed by 6 alphanumeric characters (e.g., SS-A7F9K2)
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let result = 'SS-';
    for (let i = 0; i < 6; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

function isPublicIdUnique(publicId) {
    const ads = JSON.parse(fs.readFileSync(adsFile, 'utf8'));
    return !ads.some(ad => ad.publicId === publicId);
}

function getUniquePublicId() {
    let publicId;
    let attempts = 0;
    do {
        publicId = generatePublicId();
        attempts++;
        if (attempts > 100) {
            // Fallback: add timestamp to ensure uniqueness
            publicId = `SS-${Date.now().toString(36).toUpperCase()}`;
            break;
        }
    } while (!isPublicIdUnique(publicId));
    return publicId;
}

module.exports = { getUniquePublicId };
