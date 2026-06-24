const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const usersFile = path.join(__dirname, "users.json");
const sessionsFile = path.join(__dirname, "sessions.json");

if (!fs.existsSync(usersFile)) fs.writeFileSync(usersFile, "[]");
if (!fs.existsSync(sessionsFile)) fs.writeFileSync(sessionsFile, "[]");

function getUsers() {
    try {
        return JSON.parse(fs.readFileSync(usersFile, "utf8"));
    } catch (error) {
        return [];
    }
}

function saveUsers(users) {
    fs.writeFileSync(usersFile, JSON.stringify(users, null, 2));
}

function getSessions() {
    try {
        return JSON.parse(fs.readFileSync(sessionsFile, "utf8"));
    } catch (error) {
        return [];
    }
}

function saveSessions(sessions) {
    fs.writeFileSync(sessionsFile, JSON.stringify(sessions, null, 2));
}

function findOrCreateUserByEmail(email) {
    const users = getUsers();
    let user = users.find(u => u.email.toLowerCase() === email.toLowerCase());
    
    if (!user) {
        user = {
            id: crypto.randomUUID(),
            email: email.toLowerCase(),
            createdAt: new Date().toISOString(),
            reviewIds: [],
            savedSchools: [],
            followedSchools: []
        };
        users.push(user);
        saveUsers(users);
    }
    
    return user;
}

function getUserById(userId) {
    const users = getUsers();
    return users.find(u => u.id === userId);
}

function addReviewToUser(userId, reviewId) {
    const users = getUsers();
    const userIndex = users.findIndex(u => u.id === userId);
    if (userIndex !== -1 && !users[userIndex].reviewIds.includes(reviewId)) {
        users[userIndex].reviewIds.push(reviewId);
        saveUsers(users);
    }
}

function removeReviewFromUser(userId, reviewId) {
    const users = getUsers();
    const userIndex = users.findIndex(u => u.id === userId);
    if (userIndex !== -1) {
        users[userIndex].reviewIds = users[userIndex].reviewIds.filter(id => id !== reviewId);
        saveUsers(users);
    }
}

function addSavedSchool(userId, schoolName) {
    const users = getUsers();
    const userIndex = users.findIndex(u => u.id === userId);
    if (userIndex !== -1 && !users[userIndex].savedSchools.includes(schoolName)) {
        users[userIndex].savedSchools.push(schoolName);
        saveUsers(users);
    }
}

function removeSavedSchool(userId, schoolName) {
    const users = getUsers();
    const userIndex = users.findIndex(u => u.id === userId);
    if (userIndex !== -1) {
        users[userIndex].savedSchools = users[userIndex].savedSchools.filter(s => s !== schoolName);
        saveUsers(users);
    }
}

function createSession(userId) {
    const sessions = getSessions();
    const token = crypto.randomBytes(32).toString("hex");
    const session = {
        token: token,
        userId: userId,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
    };
    sessions.push(session);
    saveSessions(sessions);
    return token;
}

function getSession(token) {
    const sessions = getSessions();
    const session = sessions.find(s => s.token === token);
    if (session && new Date(session.expiresAt) > new Date()) {
        return session;
    }
    return null;
}

function deleteSession(token) {
    const sessions = getSessions();
    const filtered = sessions.filter(s => s.token !== token);
    saveSessions(filtered);
}

module.exports = {
    findOrCreateUserByEmail,
    getUserById,
    addReviewToUser,
    removeReviewFromUser,
    addSavedSchool,
    removeSavedSchool,
    createSession,
    getSession,
    deleteSession
};

function addSavedReview(userId, reviewId) {
    const users = getUsers();
    const userIndex = users.findIndex(u => u.id === userId);
    if (userIndex !== -1 && !users[userIndex].savedReviewIds) {
        users[userIndex].savedReviewIds = [];
    }
    if (userIndex !== -1 && !users[userIndex].savedReviewIds.includes(reviewId.toString())) {
        users[userIndex].savedReviewIds.push(reviewId.toString());
        saveUsers(users);
        return true;
    }
    return false;
}

function removeSavedReview(userId, reviewId) {
    const users = getUsers();
    const userIndex = users.findIndex(u => u.id === userId);
    if (userIndex !== -1 && users[userIndex].savedReviewIds) {
        users[userIndex].savedReviewIds = users[userIndex].savedReviewIds.filter(id => id !== reviewId.toString());
        saveUsers(users);
        return true;
    }
    return false;
}

function getSavedReviews(userId) {
    const users = getUsers();
    const user = users.find(u => u.id === userId);
    if (user && user.savedReviewIds) {
        return user.savedReviewIds;
    }
    return [];
}

module.exports = { findOrCreateUserByEmail, getUserById, addReviewToUser, removeReviewFromUser, addSavedSchool, removeSavedSchool, createSession, getSession, deleteSession, addSavedReview, removeSavedReview, getSavedReviews };
