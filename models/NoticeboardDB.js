const { getUniquePublicId } = require("./AdIdGenerator");
const fs = require("fs");
const path = require("path");

const adsFile = path.join(__dirname, "noticeboard_ads.json");
const messagesFile = path.join(__dirname, "noticeboard_messages.json");

if (!fs.existsSync(adsFile)) fs.writeFileSync(adsFile, "[]");
if (!fs.existsSync(messagesFile)) fs.writeFileSync(messagesFile, "[]");

function getAds() {
    try {
        return JSON.parse(fs.readFileSync(adsFile, "utf8"));
    } catch (error) {
        return [];
    }
}

function saveAds(ads) {
    fs.writeFileSync(adsFile, JSON.stringify(ads, null, 2));
}

function getMessages() {
    try {
        return JSON.parse(fs.readFileSync(messagesFile, "utf8"));
    } catch (error) {
        return [];
    }
}

function saveMessages(messages) {
    fs.writeFileSync(messagesFile, JSON.stringify(messages, null, 2));
}

function createAd(adData) {
    const ads = getAds();
    const newAd = {
        id: Date.now().toString(),
        publicId: getUniquePublicId(),
        schoolName: adData.schoolName,
        title: adData.title,
        description: adData.description,
        category: adData.category,
        price: adData.price,
        isFree: adData.price === "0" || adData.price === "free" || adData.price === "FREE",
        isWanted: adData.isWanted || false,
        condition: adData.condition,
        imageUrl: adData.imageUrl || null,
        userId: adData.userId,
        userEmail: adData.userEmail,
        status: "active",
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
    };
    ads.push(newAd);
    saveAds(ads);
    return newAd;
}

function getAdsBySchool(schoolName) {
    const ads = getAds();
    return ads.filter(ad => ad.schoolName === schoolName && ad.status === "active");
}

function getAdById(adId) {
    const ads = getAds();
    return ads.find(ad => ad.id === adId);
}

function deleteAd(adId, userId) {
    const ads = getAds();
    const adIndex = ads.findIndex(ad => ad.id === adId && ad.userId === userId);
    if (adIndex !== -1) {
        ads[adIndex].status = "deleted";
        saveAds(ads);
        return true;
    }
    return false;
}

function createMessage(messageData) {
    const messages = getMessages();
    const newMessage = {
        id: Date.now().toString(),
        adId: messageData.adId,
        fromUserId: messageData.fromUserId,
        toUserId: messageData.toUserId,
        message: messageData.message,
        createdAt: new Date().toISOString(),
        isRead: false
    };
    messages.push(newMessage);
    saveMessages(messages);
    return newMessage;
}

function getMessagesForUser(userId) {
    const messages = getMessages();
    return messages.filter(m => m.toUserId === userId || m.fromUserId === userId);
}

function getMessagesForAd(adId) {
    const messages = getMessages();
    return messages.filter(m => m.adId === adId);
}

module.exports = {
    createAd,
    getAds,
    getAdsBySchool,
    getAdById,
    deleteAd,
    createMessage,
    getMessagesForUser,
    getMessages,
    saveMessages,
    getMessagesForAd
};
