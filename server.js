require("dotenv").config();
const helmet = require("helmet");
const exif = require("exif");
const multer = require("multer");
const sharp = require("sharp");
const path = require("path");
const { parse } = require("tldts");
const mysql = require("mysql2/promise");

const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, "public/uploads/ads");
    },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    }
});

const upload = multer({
    storage: storage,
    limits: { fileSize: 5 * 1024 * 1024, files: 5 },
    fileFilter: function (req, file, cb) {
        const filetypes = /jpeg|jpg|png/;
        const mimetype = filetypes.test(file.mimetype);
        const extname = filetypes.test(path.extname(file.originalname).toLowerCase());
        if (mimetype && extname) {
            return cb(null, true);
        }
        cb(new Error("Only .jpeg, .jpg and .png files are allowed"));
    }
});
const express = require("express");
const rateLimit = require("express-rate-limit");
const sanitizeHtml = require("sanitize-html");
const fs = require("fs");
const crypto = require("crypto");
const { sendEmail } = require("./config/email");
const { stripExifFromFile } = require("./strip-exif.js");
const app = express();

// ========== MYSQL DATABASE CONNECTION ==========
const pool = mysql.createPool({
    host: 'localhost',
    port: process.env.DB_PORT || 3306,
    user: 'root',
    password: process.env.DB_PASSWORD || '',
    database: 'schoolsentiment',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// ========== DATABASE HELPER FUNCTIONS ==========
async function query(sql, params) {
    const [rows] = await pool.query(sql, params);
    return rows;
}

async function queryOne(sql, params) {
    const rows = await query(sql, params);
    return rows[0] || null;
}

async function run(sql, params) {
    const [result] = await pool.query(sql, params);
    return result;
}

// ========== IMAGE ATTACHMENT FUNCTIONS ==========
async function attachImagesToAd(ad) {
    if (!ad) return ad;
    try {
        const images = await query("SELECT * FROM ad_images WHERE adId = ? ORDER BY position ASC", [ad.id]);
        ad.images = images;
        ad.imageUrls = images.map(img => img.imageUrl);
        if (images.length === 0 && ad.imageUrl) {
            ad.imageUrls = [ad.imageUrl];
        }
        return ad;
    } catch (e) {
        console.error("Error attaching images to ad:", e.message);
        ad.images = [];
        ad.imageUrls = ad.imageUrl ? [ad.imageUrl] : [];
        return ad;
    }
}

async function attachImagesToAds(ads) {
    const result = [];
    for (const ad of ads) {
        result.push(await attachImagesToAd(ad));
    }
    return result;
}

// ========== DATABASE FUNCTIONS ==========

async function getUsers() {
    return await query("SELECT * FROM users");
}

async function findOrCreateUserByEmail(email, termsAgreedAt = null) {
    let user = await queryOne("SELECT * FROM users WHERE email = ?", [email]);
    if (!user) {
        const id = crypto.randomUUID();
        const agreedAt = termsAgreedAt || new Date().toISOString();
        await run(
            `INSERT INTO users (id, email, createdAt, reviewIds, savedSchools, followedSchools, savedReviewIds, termsAgreedAt)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [id, email, new Date().toISOString(), '[]', '[]', '[]', '[]', agreedAt]
        );
        user = await queryOne("SELECT * FROM users WHERE id = ?", [id]);
    }
    return user;
}

async function getUserById(userId) {
    return await queryOne("SELECT * FROM users WHERE id = ?", [userId]);
}

async function addReviewToUser(userId, reviewId) {
    const user = await getUserById(userId);
    if (user) {
        let reviewIds = [];
        try {
            if (typeof user.reviewIds === 'string') {
                reviewIds = JSON.parse(user.reviewIds || '[]');
            } else if (Array.isArray(user.reviewIds)) {
                reviewIds = user.reviewIds;
            } else {
                reviewIds = [];
            }
        } catch(e) {
            reviewIds = [];
        }
        if (!reviewIds.includes(reviewId)) {
            reviewIds.push(reviewId);
            await run("UPDATE users SET reviewIds = ? WHERE id = ?", [JSON.stringify(reviewIds), userId]);
        }
    }
}

async function removeReviewFromUser(userId, reviewId) {
    const user = await getUserById(userId);
    if (user) {
        let reviewIds = [];
        try { 
            reviewIds = JSON.parse(user.reviewIds || '[]'); 
        } catch(e) { 
            reviewIds = []; 
        }
        reviewIds = reviewIds.filter(id => id !== reviewId);
        await run("UPDATE users SET reviewIds = ? WHERE id = ?", [JSON.stringify(reviewIds), userId]);
    }
}

async function addSavedSchool(userId, schoolName) {
    const user = await getUserById(userId);
    if (user) {
        let savedSchools = [];
        try { savedSchools = JSON.parse(user.savedSchools || '[]'); } catch(e) { savedSchools = []; }
        if (!savedSchools.includes(schoolName)) {
            savedSchools.push(schoolName);
            await run("UPDATE users SET savedSchools = ? WHERE id = ?", [JSON.stringify(savedSchools), userId]);
        }
    }
}

async function removeSavedSchool(userId, schoolName) {
    const user = await getUserById(userId);
    if (user) {
        let savedSchools = [];
        try { savedSchools = JSON.parse(user.savedSchools || '[]'); } catch(e) { savedSchools = []; }
        savedSchools = savedSchools.filter(s => s !== schoolName);
        await run("UPDATE users SET savedSchools = ? WHERE id = ?", [JSON.stringify(savedSchools), userId]);
    }
}

async function addSavedReview(userId, reviewId) {
    const user = await getUserById(userId);
    if (user) {
        let savedReviewIds = [];
        try {
            if (typeof user.savedReviewIds === 'string') {
                savedReviewIds = JSON.parse(user.savedReviewIds || '[]');
            } else if (Array.isArray(user.savedReviewIds)) {
                savedReviewIds = user.savedReviewIds;
            } else {
                savedReviewIds = [];
            }
        } catch(e) {
            savedReviewIds = [];
        }
        if (!savedReviewIds.includes(reviewId.toString())) {
            savedReviewIds.push(reviewId.toString());
            await run("UPDATE users SET savedReviewIds = ? WHERE id = ?", [JSON.stringify(savedReviewIds), userId]);
        }
    }
}

async function removeSavedReview(userId, reviewId) {
    const user = await getUserById(userId);
    if (user) {
        let savedReviewIds = [];
        try {
            if (typeof user.savedReviewIds === 'string') {
                savedReviewIds = JSON.parse(user.savedReviewIds || '[]');
            } else if (Array.isArray(user.savedReviewIds)) {
                savedReviewIds = user.savedReviewIds;
            } else {
                savedReviewIds = [];
            }
        } catch(e) {
            savedReviewIds = [];
        }
        savedReviewIds = savedReviewIds.filter(id => id !== reviewId.toString());
        await run("UPDATE users SET savedReviewIds = ? WHERE id = ?", [JSON.stringify(savedReviewIds), userId]);
    }
}

async function getSavedReviews(userId) {
    const user = await getUserById(userId);
    if (!user) return [];
    try {
        if (typeof user.savedReviewIds === 'string') {
            return JSON.parse(user.savedReviewIds || '[]');
        } else if (Array.isArray(user.savedReviewIds)) {
            return user.savedReviewIds;
        } else {
            return [];
        }
    } catch(e) {
        return [];
    }
}

async function getReviews() {
    return await query("SELECT * FROM reviews WHERE (hidden = 0 OR hidden IS NULL) ORDER BY createdAt DESC");
}

async function getReviewById(id) {
    return await queryOne("SELECT * FROM reviews WHERE id = ?", [id]);
}

async function saveReview(review) {
    const id = Date.now().toString();
    await run(
        `INSERT INTO reviews (
            id, schoolName, userType, rating, reviewText, reviewTitle, recommend,
            yearFrom, yearTo, yearGroup, teachingRating, facilitiesRating, pastoralRating,
            extraRating, senRating, mealsRating, isAnonymous, userId, createdAt,
            editHistory, lastEditedAt
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            id,
            review.schoolName,
            review.userType || null,
            review.rating || null,
            review.reviewText || null,
            review.reviewTitle || null,
            review.recommend || null,
            review.yearFrom || null,
            review.yearTo || null,
            review.yearGroup || null,
            review.teachingRating || null,
            review.facilitiesRating || null,
            review.pastoralRating || null,
            review.extraRating || null,
            review.senRating || null,
            review.mealsRating || null,
            review.isAnonymous ? 1 : 0,
            review.userId || null,
            new Date().toISOString(),
            '[]',
            null
        ]
    );
    return await getReviewById(id);
}

async function updateReview(reviewId, updatedData) {
    const review = await getReviewById(reviewId);
    if (!review) return null;
    let editHistory = [];
    try { editHistory = JSON.parse(review.editHistory || '[]'); } catch(e) { editHistory = []; }
    editHistory.push({
        text: review.reviewText,
        rating: review.rating,
        editedAt: new Date().toISOString()
    });
    await run(
        `UPDATE reviews SET
            reviewText = ?, reviewTitle = ?, rating = ?,
            teachingRating = ?, facilitiesRating = ?, pastoralRating = ?,
            extraRating = ?, senRating = ?, mealsRating = ?,
            recommend = ?, yearFrom = ?, yearTo = ?, yearGroup = ?,
            userType = ?, editHistory = ?, lastEditedAt = ?
        WHERE id = ?`,
        [
            updatedData.reviewText || review.reviewText,
            updatedData.reviewTitle || review.reviewTitle,
            updatedData.rating || review.rating,
            updatedData.teachingRating || review.teachingRating,
            updatedData.facilitiesRating || review.facilitiesRating,
            updatedData.pastoralRating || review.pastoralRating,
            updatedData.extraRating || review.extraRating,
            updatedData.senRating || review.senRating,
            updatedData.mealsRating || review.mealsRating,
            updatedData.recommend || review.recommend,
            updatedData.yearFrom || review.yearFrom,
            updatedData.yearTo || review.yearTo,
            updatedData.yearGroup || review.yearGroup,
            updatedData.userType || review.userType,
            JSON.stringify(editHistory),
            new Date().toISOString(),
            reviewId
        ]
    );
    return await getReviewById(reviewId);
}

async function deleteReview(reviewId) {
    await run("DELETE FROM reviews WHERE id = ?", [reviewId]);
    return true;
}

// ========== AD FUNCTIONS ==========
async function getAds() {
    const ads = await query("SELECT * FROM ads WHERE status = 'active' OR status = 'sold' OR status = 'deleted' ORDER BY createdAt DESC");
    return await attachImagesToAds(ads);
}

async function getAdById(adId) {
    const ad = await queryOne("SELECT * FROM ads WHERE id = ?", [adId]);
    return await attachImagesToAd(ad);
}

async function getAdsBySchool(schoolName) {
    const ads = await query("SELECT * FROM ads WHERE schoolName = ? AND status = 'active' ORDER BY createdAt DESC", [schoolName]);
    return await attachImagesToAds(ads);
}

async function createAd(adData) {
    const id = Date.now().toString();
    const { getUniquePublicId } = require('./models/AdIdGenerator');
    const publicId = getUniquePublicId();
    await run(
        `INSERT INTO ads (
            id, publicId, schoolName, title, description, category, price,
            isFree, isWanted, \`condition\`, imageUrl, userId, userEmail,
            status, createdAt, expiresAt, lastEditedAt
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            id,
            publicId,
            adData.schoolName,
            adData.title || null,
            adData.description || null,
            adData.category || null,
            adData.price || null,
            adData.isFree ? 1 : 0,
            adData.isWanted ? 1 : 0,
            adData.condition || null,
            null,
            adData.userId,
            adData.userEmail || null,
            'active',
            new Date().toISOString(),
            new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
            null
        ]
    );
    if (adData.imageUrls && adData.imageUrls.length > 0) {
        await saveAdImages(id, adData.imageUrls);
    }
    return await getAdById(id);
}

async function deleteAd(adId, userId) {
    const ad = await getAdById(adId);
    if (ad && ad.userId === userId) {
        await run("UPDATE ads SET status = 'deleted' WHERE id = ?", [adId]);
        return true;
    }
    return false;
}

async function updateAd(adId, adData) {
    await run(
        `UPDATE ads SET
            title = ?, description = ?, category = ?, price = ?,
            isFree = ?, isWanted = ?, \`condition\` = ?,
            lastEditedAt = ?
        WHERE id = ?`,
        [
            adData.title,
            adData.description,
            adData.category,
            adData.price,
            adData.isFree ? 1 : 0,
            adData.isWanted ? 1 : 0,
            adData.condition,
            new Date().toISOString(),
            adId
        ]
    );
    if (adData.imageUrls && adData.imageUrls.length > 0) {
        if (adData.replaceImages) {
            await deleteAdImagesByAdId(adId);
        }
        await saveAdImages(adId, adData.imageUrls);
    }
    return await getAdById(adId);
}

async function saveAdImages(adId, imageUrls) {
    for (let i = 0; i < imageUrls.length; i++) {
        const id = crypto.randomUUID();
        await run(
            `INSERT INTO ad_images (id, adId, imageUrl, position, createdAt)
            VALUES (?, ?, ?, ?, NOW())`,
            [id, adId, imageUrls[i], i]
        );
    }
    return true;
}

async function getAdImages(adId) {
    return await query("SELECT * FROM ad_images WHERE adId = ? ORDER BY position ASC, createdAt ASC", [adId]);
}

async function deleteAdImage(imageId, adId, userId) {
    const ad = await getAdById(adId);
    if (!ad || ad.userId !== userId) return false;
    await run("DELETE FROM ad_images WHERE id = ? AND adId = ?", [imageId, adId]);
    return true;
}

async function deleteAdImagesByAdId(adId) {
    await run("DELETE FROM ad_images WHERE adId = ?", [adId]);
    return true;
}

// Session functions
async function createSession(userId) {
    const token = crypto.randomBytes(32).toString('hex');
    await run(
        `INSERT INTO sessions (token, userId, createdAt, expiresAt)
        VALUES (?, ?, ?, ?)`,
        [token, userId, new Date().toISOString(), new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()]
    );
    return token;
}

async function getSession(token) {
    return await queryOne("SELECT * FROM sessions WHERE token = ? AND expiresAt > ?", [token, new Date().toISOString()]);
}

async function deleteSession(token) {
    await run("DELETE FROM sessions WHERE token = ?", [token]);
}

// Message functions
async function getMessages() {
    return await query("SELECT * FROM messages ORDER BY createdAt DESC");
}

async function createMessage(messageData) {
    const id = Date.now().toString();
    await run(
        `INSERT INTO messages (id, adId, fromUserId, toUserId, message, createdAt, isRead)
        VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
            id,
            messageData.adId,
            messageData.fromUserId,
            messageData.toUserId,
            messageData.message || null,
            new Date().toISOString(),
            messageData.isRead ? 1 : 0
        ]
    );
    return { id, ...messageData };
}

async function getMessagesForUser(userId) {
    return await query(
        `SELECT * FROM messages 
        WHERE fromUserId = ? OR toUserId = ? 
        ORDER BY createdAt DESC`,
        [userId, userId]
    );
}

async function getMessagesForAd(adId) {
    return await query("SELECT * FROM messages WHERE adId = ? ORDER BY createdAt ASC", [adId]);
}

async function addSavedAd(userId, adId) {
    const user = await getUserById(userId);
    if (user) {
        let savedAdIds = [];
        try {
            if (typeof user.savedAdIds === 'string') {
                savedAdIds = JSON.parse(user.savedAdIds || '[]');
            } else if (Array.isArray(user.savedAdIds)) {
                savedAdIds = user.savedAdIds;
            } else {
                savedAdIds = [];
            }
        } catch(e) {
            savedAdIds = [];
        }
        if (!savedAdIds.includes(adId.toString())) {
            savedAdIds.push(adId.toString());
            await run("UPDATE users SET savedAdIds = ? WHERE id = ?", [JSON.stringify(savedAdIds), userId]);
            return true;
        }
    }
    return false;
}

async function removeSavedAd(userId, adId) {
    const user = await getUserById(userId);
    if (user) {
        let savedAdIds = [];
        try {
            if (typeof user.savedAdIds === 'string') {
                savedAdIds = JSON.parse(user.savedAdIds || '[]');
            } else if (Array.isArray(user.savedAdIds)) {
                savedAdIds = user.savedAdIds;
            } else {
                savedAdIds = [];
            }
        } catch(e) {
            savedAdIds = [];
        }
        savedAdIds = savedAdIds.filter(id => id !== adId.toString());
        await run("UPDATE users SET savedAdIds = ? WHERE id = ?", [JSON.stringify(savedAdIds), userId]);
        return true;
    }
    return false;
}

async function getSavedAds(userId) {
    const user = await getUserById(userId);
    if (!user) return [];
    try {
        if (typeof user.savedAdIds === 'string') {
            return JSON.parse(user.savedAdIds || '[]');
        } else if (Array.isArray(user.savedAdIds)) {
            return user.savedAdIds;
        } else {
            return [];
        }
    } catch(e) {
        return [];
    }
}

// School following functions
async function addFollowedSchool(userId, schoolName) {
    const user = await getUserById(userId);
    if (user) {
        let followedSchools = [];
        try {
            if (typeof user.followedSchools === 'string') {
                if (user.followedSchools.includes(',')) {
                    followedSchools = user.followedSchools.split(',').map(s => s.trim()).filter(s => s);
                } else {
                    followedSchools = JSON.parse(user.followedSchools || '[]');
                }
            } else if (Array.isArray(user.followedSchools)) {
                followedSchools = user.followedSchools;
            } else {
                followedSchools = [];
            }
        } catch(e) {
            try {
                followedSchools = user.followedSchools.split(',').map(s => s.trim()).filter(s => s);
            } catch(e2) {
                followedSchools = [];
            }
        }
        if (!followedSchools.includes(schoolName)) {
            followedSchools.push(schoolName);
            await run("UPDATE users SET followedSchools = ? WHERE id = ?", [JSON.stringify(followedSchools), userId]);
            return true;
        }
    }
    return false;
}

async function removeFollowedSchool(userId, schoolName) {
    const user = await getUserById(userId);
    if (user) {
        let followedSchools = [];
        try {
            if (typeof user.followedSchools === 'string') {
                if (user.followedSchools.includes(',')) {
                    followedSchools = user.followedSchools.split(',').map(s => s.trim()).filter(s => s);
                } else {
                    followedSchools = JSON.parse(user.followedSchools || '[]');
                }
            } else if (Array.isArray(user.followedSchools)) {
                followedSchools = user.followedSchools;
            } else {
                followedSchools = [];
            }
        } catch(e) {
            try {
                followedSchools = user.followedSchools.split(',').map(s => s.trim()).filter(s => s);
            } catch(e2) {
                followedSchools = [];
            }
        }
        followedSchools = followedSchools.filter(s => s !== schoolName);
        await run("UPDATE users SET followedSchools = ? WHERE id = ?", [JSON.stringify(followedSchools), userId]);
        return true;
    }
    return false;
}

async function getFollowedSchools(userId) {
    const user = await getUserById(userId);
    if (!user) return [];
    try {
        if (typeof user.followedSchools === 'string') {
            if (user.followedSchools.includes(',')) {
                return user.followedSchools.split(',').map(s => s.trim()).filter(s => s);
            } else {
                return JSON.parse(user.followedSchools || '[]');
            }
        } else if (Array.isArray(user.followedSchools)) {
            return user.followedSchools;
        } else {
            return [];
        }
    } catch(e) {
        try {
            return user.followedSchools.split(',').map(s => s.trim()).filter(s => s);
        } catch(e2) {
            return [];
        }
    }
}

async function getFollowersOfSchool(schoolName) {
    const users = await getUsers();
    const followers = [];
    console.log('Finding followers for:', schoolName);
    for (const user of users) {
        let followedSchools = [];
        try {
            if (typeof user.followedSchools === 'string') {
                if (user.followedSchools && user.followedSchools !== '[]') {
                    followedSchools = JSON.parse(user.followedSchools);
                }
            } else if (Array.isArray(user.followedSchools)) {
                followedSchools = user.followedSchools;
            }
        } catch(e) {
            console.error('Error parsing followedSchools for user:', user.email, e.message);
        }
        if (followedSchools.includes(schoolName)) {
            followers.push(user);
            console.log('Follower found:', user.email);
        }
    }
    console.log('Total followers:', followers.length);
    return followers;
}

// ========== ROUTES ==========



function sanitizeInput(input) {
    if (!input) return input;
    if (typeof input !== 'string') return input;
    return sanitizeHtml(input, {
        allowedTags: ['b', 'i', 'em', 'strong', 'p', 'br', 'ul', 'ol', 'li'],
        allowedAttributes: {},
        allowedSchemes: [],
        disallowedTagsMode: 'discard'
    });
}

function shouldAutoVerify(email, role) {
    
    try {
        const domain = email.split('@')[1].toLowerCase();
        
        if (domain.endsWith('.sch.uk')) {
            console.log(`✅ Auto-verify: ${domain} is a UK school domain`);
            return { autoVerify: true, reason: "UK school domain (.sch.uk)" };
        }
        
        if (domain.endsWith('.ac.uk')) {
            const subdomain = domain.split('.')[0];
            if (subdomain.includes('student') || subdomain === 'students') {
                console.log(`⚠️ Manual review needed: ${domain} appears to be a student email`);
                return { autoVerify: false, reason: "Student email address detected" };
            }
            
            const staffRoles = ['Headteacher', 'Deputy Head', 'Administrator', 'Governor', 'Teacher', 'Other Staff', 'Professor', 'Lecturer', 'Researcher', 'Staff'];
            if (staffRoles.includes(role)) {
                console.log(`✅ Auto-verify: ${domain} is a UK academic domain with staff role`);
                return { autoVerify: true, reason: "UK academic domain (.ac.uk) with staff role" };
            }
            
            console.log(`⚠️ Manual review needed: ${domain} is .ac.uk but role is ${role}`);
            return { autoVerify: false, reason: "Non-staff role at academic institution" };
        }
        
        console.log(`⚠️ Manual review needed: ${domain} is not a UK school domain`);
        return { autoVerify: false, reason: "Email domain not automatically verifiable" };
    } catch (err) {
        console.log(`⚠️ Error checking domain: ${err.message}`);
        return { autoVerify: false, reason: "Could not verify email domain" };
    }
}

const magicLinkLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    message: { error: "Too many requests. Please wait 15 minutes before trying again." },
    standardHeaders: true,
    legacyHeaders: false,
});

const schoolSignupLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 3,
    message: { error: "Too many sign-up attempts. Please wait 1 hour before trying again." },
    standardHeaders: true,
    legacyHeaders: false,
});

const contactLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 5,
    message: { error: "Too many contact requests. Please wait 1 hour before trying again." },
    standardHeaders: true,
    legacyHeaders: false,
});

const PORT = process.env.PORT || 3000;

const schoolsData = JSON.parse(fs.readFileSync(path.join(__dirname, "models/uk-schools.json"), "utf8"));

app.set("view engine", "ejs");
app.use(express.static("public"));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Disable caching for all routes
app.use(function(req, res, next) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    next();
});

// Security headers with Helmet
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"],
            scriptSrcAttr: ["'unsafe-inline'"],
            styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
            fontSrc: ["'self'", "https://fonts.gstatic.com"],
            imgSrc: ["'self'", "data:", "https:", "blob:"],
            connectSrc: ["'self'"],
        },
    },
}));

app.set('trust proxy', 1);

app.use(async (req, res, next) => {
    req.cookies = {};
    if (req.headers.cookie) {
        req.headers.cookie.split(';').forEach(cookie => {
            const [name, value] = cookie.trim().split('=');
            if (name && value) {
                req.cookies[name] = decodeURIComponent(value);
            }
        });
    }
    
    const token = req.cookies.sessionToken;
    if (token) {
        const session = await getSession(token);
        if (session) {
            const user = await getUserById(session.userId);
            if (user) {
                req.user = user;
            }
        }
    }
    res.locals.currentUser = req.user || null;
    next();
});

app.get("/", (req, res) => {
    res.render("index", { title: "SchoolSentiment - Honest School Reviews", message: "Share your experience anonymously", currentPage: 'home' });
});

app.get("/school", (req, res) => {
    const schoolName = req.query.name;
    if (!schoolName) return res.redirect("/");
    const matchedSchool = schoolsData.find(school => school.name.toLowerCase().includes(schoolName.toLowerCase()));
    if (matchedSchool) {
        return res.redirect(`/school/${encodeURIComponent(matchedSchool.name)}`);
    } else {
        const similarSchools = schoolsData.filter(school => school.name.toLowerCase().includes(schoolName.toLowerCase()) || school.town.toLowerCase().includes(schoolName.toLowerCase()));
        if (similarSchools.length > 0) {
            return res.redirect(`/school/${encodeURIComponent(similarSchools[0].name)}`);
        } else {
            return res.send(`<h1>School Not Found</h1><p>No school found matching "${schoolName}".</p><a href="/">Back to Home</a>`);
        }
    }
});

app.get("/review", (req, res) => {
    const userAgent = req.headers["user-agent"] || "";
    const isMobile = /Mobile|Android|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(userAgent);
    
    if (isMobile) {
        res.render("review-mobile", { title: "Leave Review - SchoolSentiment", schools: schoolsData, currentPage: "review" });
    } else {
        res.render("review", { title: "Leave Review - SchoolSentiment", schools: schoolsData, currentPage: "review" });
    }
});

app.get("/nearby-map", (req, res) => {
    res.render("nearby-map", {
        title: "Schools Near Me - SchoolSentiment",
        schools: schoolsData,
        currentPage: "nearby"
    });
});

app.get("/school/:name", async (req, res) => {
    const schoolName = decodeURIComponent(req.params.name);
    const page = parseInt(req.query.page) || 1;
    const limit = 10;
    const offset = (page - 1) * limit;
    
    const allReviews = await getReviews();
    let schoolReviews = allReviews.filter(review => review.schoolName.toLowerCase().includes(schoolName.toLowerCase()));
    const totalReviews = schoolReviews.length;
    const totalPages = Math.ceil(totalReviews / limit);
    const paginatedReviews = schoolReviews.slice(offset, offset + limit);
    
    const schoolDetails = schoolsData.find(school => school.name.toLowerCase() === schoolName.toLowerCase()) || { name: schoolName };
    const averageRating = schoolReviews.length > 0 ? schoolReviews.reduce((sum, review) => sum + (review.rating || 0), 0) / schoolReviews.length : 0;
    
    const verified = await queryOne("SELECT * FROM verified_schools WHERE schoolName = ?", [schoolName]);
    const existingClaim = req.user ? await queryOne("SELECT * FROM school_claims WHERE schoolName = ? AND claimantUserId = ? AND status = 'pending'", [schoolName, req.user.id]) : null;
    const replies = await query("SELECT * FROM school_responses WHERE schoolName = ? AND hidden = 0 ORDER BY createdAt DESC", [schoolName]);
    const repliesByReviewId = {};
    replies.forEach(reply => {
        if (!repliesByReviewId[reply.reviewId]) {
            repliesByReviewId[reply.reviewId] = [];
        }
        repliesByReviewId[reply.reviewId].push(reply);
    });
    
    res.render("school-profile", {
        user: req.user || null,
        title: schoolName + " - SchoolSentiment",
        schoolName: schoolName,
        schoolDetails: schoolDetails,
        reviews: paginatedReviews,
        allReviewsForStats: schoolReviews,
        averageRating: averageRating,
        showSaved: req.query.show === "saved",
        currentPage: "school",
        isVerified: !!verified,
        hasPendingClaim: !!existingClaim,
        repliesByReviewId: repliesByReviewId,
        pagination: {
            currentPage: page,
            totalPages: totalPages,
            totalReviews: totalReviews,
            limit: limit
        }
    });
});

app.post("/submit-review", async (req, res) => {
    if (req.user && req.user.banned === 1) {
        return res.status(403).send(`<!DOCTYPE html><html><head><title>Account Suspended - SchoolSentiment</title></head><body style="font-family: Arial, sans-serif; text-align: center; padding: 50px; max-width: 600px; margin: 0 auto;"><h1 style="color: #dc2626;">⚠️ Account Suspended</h1><p>Your account has been suspended due to a previous review being flagged.</p><p>You can still:</p><ul style="text-align: left; display: inline-block;"><li>✓ Save reviews to your dashboard</li><li>✓ Browse the noticeboard</li><li>✓ Reply to messages from sellers</li></ul><p>If you believe this is a mistake, please contact support.</p><a href="/dashboard" style="display: inline-block; margin-top: 20px; background: #4f46e5; color: white; padding: 10px 20px; text-decoration: none; border-radius: 8px;">Return to Dashboard</a></body></html>`);
    }
    try {
        let calculatedRating = req.body.rating;
        if (!calculatedRating || calculatedRating === 'null') {
            const teaching = parseInt(req.body.teachingRating) || 0;
            const facilities = parseInt(req.body.facilitiesRating) || 0;
            const pastoral = parseInt(req.body.pastoralRating) || 0;
            const extra = parseInt(req.body.extraRating) || 0;
            const sen = parseInt(req.body.senRating) || 0;
            const meals = parseInt(req.body.mealsRating) || 0;
            const total = teaching + facilities + pastoral + extra + sen + meals;
            if (total > 0) {
                calculatedRating = Math.round(total / 6);
            }
        }
        
        const newReview = {
            schoolName: sanitizeInput(req.body.schoolName),
            userType: req.body.userType,
            rating: calculatedRating ? parseInt(calculatedRating) : null,
            reviewText: sanitizeInput(req.body.reviewText),
            reviewTitle: req.body.reviewTitle ? sanitizeInput(req.body.reviewTitle) : null,
            recommend: req.body.recommend || null,
            yearFrom: req.body.yearFrom || null,
            yearTo: req.body.yearTo || null,
            yearGroup: req.body.yearGroup || null,
            teachingRating: req.body.teachingRating ? parseInt(req.body.teachingRating) : null,
            facilitiesRating: req.body.facilitiesRating ? parseInt(req.body.facilitiesRating) : null,
            pastoralRating: req.body.pastoralRating ? parseInt(req.body.pastoralRating) : null,
            extraRating: req.body.extraRating ? parseInt(req.body.extraRating) : null,
            senRating: req.body.senRating ? parseInt(req.body.senRating) : null,
            mealsRating: req.body.mealsRating ? parseInt(req.body.mealsRating) : null,
            isAnonymous: true,
            userId: req.user ? req.user.id : null
        };
        
        const savedReview = await saveReview(newReview);

        const followers = await getFollowersOfSchool(req.body.schoolName);
        if (followers.length > 0) {
            for (const follower of followers) {
                if (follower.email !== (req.user ? req.user.email : "")) {
                    try {
                        await run(
                            `INSERT INTO notifications (userId, type, schoolName, reviewId, message, createdAt, isRead) VALUES (?, 'review', ?, ?, 'New review posted for school you follow', NOW(), 0)`,
                            [follower.id, req.body.schoolName, savedReview.id]
                        );
                        await sendEmail(follower.email, `New Review at ${req.body.schoolName}`, `
                            <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 580px; margin: 0 auto; padding: 0; border: 1px solid #e2e8f0; border-radius: 16px; background: #ffffff; box-shadow: 0 4px 6px rgba(0,0,0,0.05);">
                                <div style="text-align: center; padding: 30px 24px 24px 24px; background: linear-gradient(135deg, #1e293b 0%, #0f172a 100%); border-radius: 16px 16px 0 0;">
                                    <img src="https://schoolsentiment.co.uk/logo/SchoolSentiment_white_transparency.png" alt="School Sentiment" style="max-height: 65px; width: auto; margin-bottom: 12px;">
                                    <div style="color: #94a3b8; font-size: 13px; letter-spacing: 2px; text-transform: uppercase; font-weight: 600;">New Review</div>
                                    <h2 style="color: #ffffff; margin: 6px 0 0 0; font-size: 22px; font-weight: 700;">${req.body.schoolName}</h2>
                                </div>
                                <div style="padding: 28px 24px;">
                                    <div style="display: flex; align-items: center; margin-bottom: 6px;">
                                        <span style="color: #4f46e5; font-size: 18px; margin-right: 10px;">◈</span>
                                        <span style="font-size: 15px; color: #1e293b;"><strong>School:</strong> ${req.body.schoolName}</span>
                                    </div>
                                    <div style="display: flex; align-items: center; margin-bottom: 6px;">
                                        <span style="color: #f59e0b; font-size: 18px; margin-right: 10px;">★</span>
                                        <span style="font-size: 15px; color: #1e293b;"><strong>Rating:</strong> ${calculatedRating || "N/A"}/5</span>
                                    </div>
                                    <div style="background: #f8fafc; padding: 16px 18px; border-radius: 10px; margin: 16px 0 20px 0; border-left: 4px solid #4f46e5;">
                                        <p style="margin: 0; color: #475569; font-size: 14px; line-height: 1.6; font-style: italic;">"${(req.body.reviewText || "").substring(0, 200)}${(req.body.reviewText || "").length > 200 ? '...' : ''}"</p>
                                    </div>
                                    <a href="https://schoolsentiment.co.uk/school/${encodeURIComponent(req.body.schoolName)}" style="display: inline-block; background: #4f46e5; color: white; padding: 12px 28px; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 15px;">Read Full Review →</a>
                                </div>
                                <div style="border-top: 1px solid #e2e8f0; padding: 16px 24px; text-align: center; font-size: 11px; color: #94a3b8; background: #f8fafc; border-radius: 0 0 16px 16px;">
                                    <p style="margin: 0;">You received this because you follow ${req.body.schoolName} on School Sentiment</p>
                                    <p style="margin: 6px 0 0 0;">
                                        <a href="https://schoolsentiment.co.uk/school/${encodeURIComponent(req.body.schoolName)}" style="color: #4f46e5; text-decoration: none;">Unfollow this school</a> · 
                                        <a href="https://schoolsentiment.co.uk/dashboard" style="color: #4f46e5; text-decoration: none;">Dashboard</a>
                                    </p>
                                    <p style="margin: 8px 0 0 0; color: #cbd5e1;">© 2026 School Sentiment</p>
                                </div>
                            </div>`);
                    } catch(emailErr) {
                        console.error("Failed to send email to follower:", emailErr.message);
                    }
                }
            }
        }
        
        if (req.user) {
            await addReviewToUser(req.user.id, savedReview.id.toString());
        }
        
        res.render("thank-you", { title: "Review Submitted - SchoolSentiment", schoolName: req.body.schoolName, currentPage: "review" });
    } catch (error) {
        console.error("Error saving review:", error);
        res.status(500).send("<h1>Error</h1><p>Sorry, there was an error submitting your review.</p>");
    }
});

app.get("/dashboard", async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    if (!req.user) {
        return res.redirect("/signin?message=Please sign in to view your dashboard");
    }
    
    const allReviews = await getReviews();
    const userReviews = allReviews.filter(review => review.userId === req.user.id);
    const allAds = await getAds();
    const userAds = allAds.filter(ad => ad.userId === req.user.id && (ad.status === "active" || ad.status === "sold"));
    
    let savedReviewsGrouped = {};
    let totalSavedCount = 0;
    try {
        const savedReviewIds = await getSavedReviews(req.user.id);
        const savedReviews = allReviews.filter(r => savedReviewIds.includes(r.id.toString()));
        
        savedReviews.forEach(review => {
            if (!savedReviewsGrouped[review.schoolName]) {
                savedReviewsGrouped[review.schoolName] = [];
            }
            savedReviewsGrouped[review.schoolName].push(review);
            totalSavedCount++;
        });
    } catch(e) {
        console.log("Error loading saved reviews:", e.message);
    }
    
    let schoolRepresentative = null;
    if (req.user.isSchoolStaff === 1) {
        const userRecord = await queryOne("SELECT schoolRepresentative FROM users WHERE id = ?", [req.user.id]);
        schoolRepresentative = userRecord ? userRecord.schoolRepresentative : null;
    }
    
    res.render("dashboard", {
        title: "My Dashboard - SchoolSentiment",
        currentPage: "dashboard",
        user: req.user,
        userReviews: userReviews,
        savedReviewsGrouped: savedReviewsGrouped,
        userAds: userAds,
        totalSavedCount: totalSavedCount,
        schoolRepresentative: schoolRepresentative
    });
});

app.get("/edit-review/:id", async (req, res) => {
    if (!req.user) {
        return res.redirect("/signin?message=Please sign in to edit reviews");
    }
    
    const reviewId = req.params.id;
    const review = await getReviewById(reviewId);
    
    if (!review || review.userId !== req.user.id) {
        return res.redirect("/dashboard?message=Review not found or you don't have permission");
    }
    
    res.render("edit-review", {
        title: "Edit Review - SchoolSentiment",
        currentPage: "dashboard",
        review: review,
        schools: schoolsData,
        isEditing: true
    });
});

app.post("/update-review/:id", async (req, res) => {
    if (!req.user) {
        return res.status(401).send("Unauthorized");
    }
    
    const reviewId = req.params.id;
    const existingReview = await getReviewById(reviewId);
    
    if (!existingReview || existingReview.userId !== req.user.id) {
        return res.redirect("/dashboard?message=Review not found or permission denied");
    }
    
    const teaching = parseInt(req.body.teachingRating) || 0;
    const facilities = parseInt(req.body.facilitiesRating) || 0;
    const pastoral = parseInt(req.body.pastoralRating) || 0;
    const extra = parseInt(req.body.extraRating) || 0;
    const sen = parseInt(req.body.senRating) || 0;
    const meals = parseInt(req.body.mealsRating) || 0;
    const total = teaching + facilities + pastoral + extra + sen + meals;
    const calculatedRating = total > 0 ? Math.round(total / 6) : 0;
    
    const updatedData = {
        reviewText: req.body.reviewText,
        reviewTitle: req.body.reviewTitle,
        rating: calculatedRating,
        teachingRating: teaching,
        facilitiesRating: facilities,
        pastoralRating: pastoral,
        extraRating: extra,
        senRating: sen,
        mealsRating: meals,
        recommend: req.body.recommend,
        yearFrom: req.body.yearFrom,
        yearTo: req.body.yearTo,
        yearGroup: req.body.yearGroup,
        userType: req.body.userType
    };
    
    await updateReview(reviewId, updatedData);
    
    res.redirect("/dashboard?message=Review updated successfully");
});

app.post("/delete-review/:id", async (req, res) => {
    if (!req.user) {
        return res.status(401).send("Unauthorized");
    }
    
    const reviewId = req.params.id;
    const review = await getReviewById(reviewId);
    
    if (!review || review.userId !== req.user.id) {
        return res.redirect("/dashboard?message=Review not found or permission denied");
    }
    
    await deleteReview(reviewId);
    await removeReviewFromUser(req.user.id, reviewId);
    
    res.redirect("/dashboard?message=Review deleted successfully");
});

app.post("/save-school", async (req, res) => {
    if (!req.user) {
        return res.status(401).json({ error: "Not authenticated" });
    }
    
    const schoolName = req.body.schoolName;
    await addSavedSchool(req.user.id, schoolName);
    res.json({ success: true });
});

app.get("/signout", async (req, res) => {
    const token = req.cookies?.sessionToken;
    if (token) {
        await deleteSession(token);
    }
    res.setHeader("Set-Cookie", "sessionToken=; Path=/; Max-Age=0");
    res.redirect("/");
});

app.get("/all-reviews", async (req, res) => {
    res.json(await getReviews());
});

app.get("/api/schools", (req, res) => {
    res.json(schoolsData);
});

app.get("/blog", (req, res) => {
    res.render("blog", { title: "Blog - SchoolSentiment", posts: [], currentPage: 'blog' });
});

app.get("/terms", (req, res) => {
    res.render("terms", { title: "Terms of Service - SchoolSentiment", currentPage: "terms" });
});

app.get("/privacy", (req, res) => {
    res.render("privacy", { title: "Privacy Policy - SchoolSentiment", currentPage: "privacy" });
});

app.get("/contact", (req, res) => {
    res.render("contact", { title: "Contact Us - SchoolSentiment", currentPage: "contact" });
});

app.get("/go-nearby", (req, res) => {
    res.send(`<!DOCTYPE html><html><head><title>Finding your location...</title><script>if (!navigator.geolocation) { window.location.href = '/review'; } else { navigator.geolocation.getCurrentPosition(function(position) { const lat = position.coords.latitude; const lng = position.coords.longitude; const mapsUrl = 'https://www.google.com/maps/search/schools/@' + lat + ',' + lng + ',13z'; const link = document.createElement('a'); link.href = mapsUrl; link.target = '_blank'; link.rel = 'noopener noreferrer'; document.body.appendChild(link); link.click(); document.body.removeChild(link); window.close(); }, function(error) { window.location.href = '/review'; }); }</script></head><body style="display: flex; justify-content: center; align-items: center; height: 100vh; font-family: Arial; background: #f8f9fa;"><div style="text-align: center;"><h2>📍 Finding your location...</h2><p>Please wait while we locate schools near you.</p></div></body></html>`);
});

app.post("/flag-review", async (req, res) => {
    const { reviewId, reviewTitle, schoolName, reason, details } = req.body;
    
    if (!reviewId || !reason) {
        return res.status(400).json({ error: "Missing required fields" });
    }
    
    await run(
        `INSERT INTO flagged_reviews (reviewId, reviewTitle, schoolName, reason, details, flaggedBy, flaggedAt, status, type) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 'review')`,
        [reviewId, reviewTitle || null, schoolName || null, reason, details || null, req.user ? req.user.id : 'anonymous', new Date().toISOString()]
    );
    
    console.log(`🚩 Review flagged: ${reviewId} - Reason: ${reason}`);
    res.json({ success: true, message: "Report submitted" });
});

app.post("/flag-reply", async (req, res) => {
    const { replyId, reviewId, schoolName, reason, details } = req.body;
    
    if (!replyId || !reason) {
        return res.status(400).json({ error: "Missing required fields" });
    }
    
    const reply = await queryOne("SELECT responseText FROM school_responses WHERE id = ?", [replyId]);
    await run(
        `INSERT INTO flagged_reviews (replyId, reviewId, reviewTitle, schoolName, reason, details, flaggedBy, flaggedAt, status, type) VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), 'pending', 'reply')`,
        [replyId, reviewId, reply ? reply.responseText.substring(0, 200) : 'School reply', schoolName, reason, details || null, req.user ? req.user.id : 'anonymous', new Date().toISOString()]
    );
    
    console.log(`🚩 School reply flagged: ${replyId} - Reason: ${reason}`);
    res.json({ success: true, message: "Report submitted" });
});

app.get("/api/flagged-items", async (req, res) => {
    const flagged = await query("SELECT * FROM flagged_reviews WHERE status = 'pending' ORDER BY flaggedAt DESC");
    res.json({ flagged: flagged });
});

app.post("/admin/delete-reply", async (req, res) => {
    const { replyId } = req.body;
    await run("DELETE FROM school_responses WHERE id = ?", [replyId]);
    res.json({ success: true });
});

app.post("/admin/hide-reply", async (req, res) => {
    const { replyId } = req.body;
    await run("UPDATE school_responses SET hidden = 1 WHERE id = ?", [replyId]);
    res.json({ success: true });
});

app.post("/admin/unhide-reply", async (req, res) => {
    const { replyId } = req.body;
    await run("UPDATE school_responses SET hidden = 0 WHERE id = ?", [replyId]);
    res.json({ success: true });
});

app.get("/admin/get-reply-status", async (req, res) => {
    const { replyId } = req.query;
    if (!replyId) return res.status(400).json({ error: "Reply ID required" });
    const reply = await queryOne("SELECT hidden FROM school_responses WHERE id = ?", [replyId]);
    res.json({ hidden: reply ? (reply.hidden === 1) : false });
});

app.post("/admin/resolve-flag", async (req, res) => {
    const { flagId } = req.body;
    await run("UPDATE flagged_reviews SET status = 'resolved' WHERE id = ? AND status = 'pending'", [flagId]);
    res.json({ success: true });
});

app.get("/admin/reply/:replyId", async (req, res) => {
    const replyId = req.params.replyId;
    const reply = await queryOne("SELECT * FROM school_responses WHERE id = ?", [replyId]);
    const flag = await queryOne("SELECT * FROM flagged_reviews WHERE replyId = ? AND status = 'pending'", [replyId]);
    res.render("admin-reply-detail", { title: "Reply Details - SchoolSentiment", reply: reply, flag: flag, currentPage: "admin" });
});

app.get("/api/flagged-reviews", async (req, res) => {
    const flagged = await query("SELECT * FROM flagged_reviews WHERE status = 'pending' AND type = 'review' ORDER BY flaggedAt DESC");
    res.json({ flagged: flagged });
});

app.post("/admin/delete-review", async (req, res) => {
    const { reviewId } = req.body;
    await run("DELETE FROM reviews WHERE id = ?", [reviewId]);
    await run("DELETE FROM school_responses WHERE reviewId = ?", [reviewId]);
    await run("UPDATE flagged_reviews SET status = 'resolved' WHERE reviewId = ?", [reviewId]);
    res.json({ success: true });
});

app.post("/admin/unban-user", async (req, res) => {
    const { reviewId } = req.body;
    const review = await queryOne("SELECT userId FROM reviews WHERE id = ?", [reviewId]);
    if (review && review.userId) {
        await run("UPDATE users SET banned = 0, bannedAt = NULL WHERE id = ?", [review.userId]);
    }
    res.json({ success: true });
});

app.post("/admin/ban-user-by-review", async (req, res) => {
    const { reviewId } = req.body;
    const review = await queryOne("SELECT userId FROM reviews WHERE id = ?", [reviewId]);
    const flag = await queryOne("SELECT reason, details FROM flagged_reviews WHERE reviewId = ? AND status = 'pending'", [reviewId]);
    let banReason = "No reason provided";
    if (flag) {
        const reasonMap = { 'defamatory': 'Defamatory / False information', 'personal': 'Contains personal information', 'hate': 'Hate speech or harassment', 'offensive': 'Offensive language', 'spam': 'Spam or advertising', 'other': 'Other - ' + (flag.details || 'No details') };
        banReason = reasonMap[flag.reason] || flag.reason;
        if (flag.details && flag.reason !== 'other') banReason += " - Details: " + flag.details;
    }
    if (review && review.userId) {
        await run("UPDATE users SET banned = 1, bannedAt = ?, bannedReason = ?, bannedForReviewId = ? WHERE id = ?", [new Date().toISOString(), banReason, reviewId, review.userId]);
    }
    res.json({ success: true });
});

app.get("/admin/flags", (req, res) => {
    res.render("admin-flags", { title: "Moderation - SchoolSentiment", currentPage: "admin" });
});

app.get("/admin/review/:reviewId", async (req, res) => {
    const reviewId = req.params.reviewId;
    const review = await queryOne("SELECT * FROM reviews WHERE id = ?", [reviewId]);
    const flag = await queryOne("SELECT * FROM flagged_reviews WHERE reviewId = ? AND status = 'pending'", [reviewId]);
    res.render("admin-review-detail", { title: "Review Details - SchoolSentiment", review: review, flag: flag, currentPage: "admin" });
});

app.get("/api/banned-users", async (req, res) => {
    const users = await query("SELECT id, email, banned, bannedAt, bannedReason, bannedForReviewId FROM users WHERE banned = 1 ORDER BY bannedAt DESC");
    res.json(users);
});

app.post("/admin/unban-user-by-id", async (req, res) => {
    const { userId } = req.body;
    await run("UPDATE users SET banned = 0, bannedAt = NULL WHERE id = ?", [userId]);
    res.json({ success: true });
});

app.get("/admin/banned-users", (req, res) => {
    res.render("admin-banned-users", { title: "Banned Users - SchoolSentiment", currentPage: "admin" });
});

app.get("/admin/banned-review/:reviewId", async (req, res) => {
    const reviewId = req.params.reviewId;
    const review = await queryOne("SELECT * FROM reviews WHERE id = ?", [reviewId]);
    res.render("admin-banned-review", { title: "Banned Review - SchoolSentiment", review: review, currentPage: "admin" });
});

app.post("/admin/hide-review", async (req, res) => {
    const { reviewId } = req.body;
    await run("UPDATE reviews SET hidden = 1 WHERE id = ?", [reviewId]);
    res.json({ success: true });
});

app.post("/admin/unhide-review", async (req, res) => {
    const { reviewId } = req.body;
    await run("UPDATE reviews SET hidden = 0 WHERE id = ?", [reviewId]);
    res.json({ success: true });
});

app.post("/admin/toggle-ban", async (req, res) => {
    const { reviewId } = req.body;
    const review = await queryOne("SELECT userId FROM reviews WHERE id = ?", [reviewId]);
    if (!review || !review.userId) {
        return res.json({ error: "Cannot ban anonymous user", banned: false });
    }
    const user = await queryOne("SELECT banned FROM users WHERE id = ?", [review.userId]);
    const currentlyBanned = user && user.banned === 1;
    if (currentlyBanned) {
        await run("UPDATE users SET banned = 0, bannedAt = NULL, bannedReason = NULL WHERE id = ?", [review.userId]);
        res.json({ banned: false, userId: review.userId });
    } else {
        const flag = await queryOne("SELECT reason, details FROM flagged_reviews WHERE reviewId = ? AND status = 'pending'", [reviewId]);
        let banReason = "No reason provided";
        if (flag) {
            const reasonMap = { 'defamatory': 'Defamatory / False information', 'personal': 'Contains personal information', 'hate': 'Hate speech or harassment', 'offensive': 'Offensive language', 'spam': 'Spam or advertising', 'other': 'Other - ' + (flag.details || 'No details') };
            banReason = reasonMap[flag.reason] || flag.reason;
        }
        await run("UPDATE users SET banned = 1, bannedAt = ?, bannedReason = ?, bannedForReviewId = ? WHERE id = ?", [new Date().toISOString(), banReason, reviewId, review.userId]);
        res.json({ banned: true, userId: review.userId });
    }
});

app.get("/admin/get-ban-status", async (req, res) => {
    const { reviewId } = req.query;
    const review = await queryOne("SELECT userId FROM reviews WHERE id = ?", [reviewId]);
    let banned = false;
    if (review && review.userId) {
        const user = await queryOne("SELECT banned FROM users WHERE id = ?", [review.userId]);
        banned = user && user.banned === 1;
    }
    res.json({ banned });
});

app.get("/api/export-my-data", async (req, res) => {
    if (!req.user) return res.status(401).json({ error: "Not authenticated" });
    const userId = req.user.id;
    const user = await queryOne("SELECT id, email, createdAt, termsAgreedAt FROM users WHERE id = ?", [userId]);
    const reviews = await query("SELECT * FROM reviews WHERE userId = ? ORDER BY createdAt DESC", [userId]);
    const savedReviewIds = await queryOne("SELECT savedReviewIds FROM users WHERE id = ?", [userId]);
    let savedReviews = [];
    if (savedReviewIds && savedReviewIds.savedReviewIds) {
        const ids = JSON.parse(savedReviewIds.savedReviewIds || '[]');
        for (const id of ids) {
            const review = await queryOne("SELECT * FROM reviews WHERE id = ?", [id]);
            if (review) savedReviews.push(review);
        }
    }
    const ads = await query("SELECT * FROM ads WHERE userId = ? AND status = 'active' ORDER BY createdAt DESC", [userId]);
    const messages = await query("SELECT * FROM messages WHERE fromUserId = ? OR toUserId = ? ORDER BY createdAt DESC", [userId, userId]);
    res.json({ exportedAt: new Date().toISOString(), account: { email: user.email, accountCreated: user.createdAt, termsAgreedAt: user.termsAgreedAt || null }, reviews: reviews, savedReviews: savedReviews, ads: ads, messages: messages });
});

app.post("/api/delete-my-account", async (req, res) => {
    if (!req.user) return res.status(401).json({ error: "Not authenticated" });
    const userId = req.user.id;
    await run("UPDATE reviews SET userId = NULL WHERE userId = ?", [userId]);
    await run("UPDATE users SET savedReviewIds = '[]' WHERE id = ?", [userId]);
    await run("UPDATE users SET savedAdIds = '[]' WHERE id = ?", [userId]);
    await run("DELETE FROM messages WHERE fromUserId = ? OR toUserId = ?", [userId, userId]);
    await run("DELETE FROM ads WHERE userId = ?", [userId]);
    await run("DELETE FROM users WHERE id = ?", [userId]);
    await run("DELETE FROM sessions WHERE userId = ?", [userId]);
    res.setHeader("Set-Cookie", "sessionToken=; Path=/; Max-Age=0");
    res.json({ success: true, message: "Account deleted successfully" });
});

app.get("/account", (req, res) => {
    if (!req.user) return res.redirect("/signin?message=Please sign in to view account settings");
    res.render("account", { title: "Account Settings - SchoolSentiment", currentPage: "account", user: req.user });
});

app.get("/signin", (req, res) => {
    res.render("signin", { title: "Sign In - SchoolSentiment", currentPage: 'signin', message: req.query.message || null, emailSent: req.query.emailSent || null, claimReviewId: req.query.claim || null });
});

app.post("/send-magic-link", magicLinkLimiter, async (req, res) => {
    const { email, claimReviewId } = req.body;
    const termsAgreed = req.body.termsAgreed === 'on' || req.body.termsAgreed === 'true';
    if (!email) return res.redirect("/signin?message=Email is required");
    if (!termsAgreed) return res.redirect("/signin?message=You must agree to the Terms of Service and Privacy Policy to create an account");
    
    
    const user = await findOrCreateUserByEmail(email, new Date().toISOString());
    const magicToken = crypto.randomBytes(32).toString("hex");
    await run("DELETE FROM magic_links WHERE userId = ?", [user.id]);
    await run(
        `INSERT INTO magic_links (token, userId, claimReviewId, expiresAt) VALUES (?, ?, ?, ?)`,
        [magicToken, user.id, claimReviewId || null, new Date(Date.now() + 15 * 60 * 1000).toISOString()]
    );
    const magicLink = `${process.env.BASE_URL || "http://localhost:3000"}/verify-magic-link?token=${magicToken}`;
    try {
        await sendEmail(email, 'Sign in to School Sentiment', `
                            <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 580px; margin: 0 auto; padding: 0; border: 1px solid #e2e8f0; border-radius: 16px; background: #ffffff; box-shadow: 0 4px 6px rgba(0,0,0,0.05);">
                                <div style="text-align: center; padding: 30px 24px 24px 24px; background: linear-gradient(135deg, #1e293b 0%, #0f172a 100%); border-radius: 16px 16px 0 0;">
                                    <img src="https://schoolsentiment.co.uk/logo/SchoolSentiment_white_transparency.png" alt="School Sentiment" style="max-height: 65px; width: auto; margin-bottom: 12px;">
                                    <div style="color: #94a3b8; font-size: 13px; letter-spacing: 2px; text-transform: uppercase; font-weight: 600;">Sign In</div>
                                    <h2 style="color: #ffffff; margin: 6px 0 0 0; font-size: 22px; font-weight: 700;">Welcome Back!</h2>
                                </div>
                                <div style="padding: 28px 24px;">
                                    <p style="font-size: 15px; color: #1e293b; margin: 0 0 16px 0;">Click the button below to sign in to your School Sentiment account. This link expires in <strong>15 minutes</strong>.</p>
                                    <div style="text-align: center; margin: 24px 0;">
                                        <a href="${magicLink}" style="display: inline-block; background: #4f46e5; color: white; padding: 14px 32px; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 16px;">Sign In →</a>
                                    </div>
                                    <p style="font-size: 13px; color: #64748b; margin: 0 0 8px 0;">Or copy and paste this link into your browser:</p>
                                    <div style="background: #f8fafc; padding: 12px 16px; border-radius: 8px; word-break: break-all; font-size: 12px; color: #4f46e5; border: 1px solid #e2e8f0;">
                                        ${magicLink}
                                    </div>
                                    <p style="font-size: 13px; color: #94a3b8; margin: 16px 0 0 0;">If you didn't request this, you can safely ignore this email.</p>
                                </div>
                                <div style="border-top: 1px solid #e2e8f0; padding: 16px 24px; text-align: center; font-size: 11px; color: #94a3b8; background: #f8fafc; border-radius: 0 0 16px 16px;">
                                    <p style="margin: 0;">School Sentiment - Honest school reviews from real parents, students, and staff</p>
                                    <p style="margin: 6px 0 0 0;">
                                        <a href="https://schoolsentiment.co.uk" style="color: #4f46e5; text-decoration: none;">Visit Website</a> · 
                                        <a href="https://schoolsentiment.co.uk/privacy" style="color: #4f46e5; text-decoration: none;">Privacy Policy</a>
                                    </p>
                                    <p style="margin: 8px 0 0 0; color: #cbd5e1;">© 2026 School Sentiment</p>
                                </div>
                            </div>`);
        res.render("magic-link-sent", { title: "Magic Link Sent - SchoolSentiment", currentPage: "signin", email: email });
    } catch (error) {
        console.error('Email error:', error);
        res.render("magic-link-error", { title: "Error - SchoolSentiment", currentPage: "signin" });
    }
});

app.get("/verify-magic-link", async (req, res) => {
    const token = req.query.token;
    console.log("🔍 Verifying token:", token);
    const now = new Date().toISOString();
    const link = await queryOne("SELECT * FROM magic_links WHERE token = ? AND expiresAt > ?", [token, now]);
    if (!link) {
        console.log("❌ Token not found or expired");
        const anyLink = await queryOne("SELECT * FROM magic_links WHERE token = ?", [token]);
        if (anyLink) {
            console.log("⚠️ Token exists but expired. ExpiresAt:", anyLink.expiresAt, "Current:", now);
        } else {
            console.log("⚠️ Token not found in database at all");
        }
        return res.redirect("/signin?message=Invalid or expired link");
    }
    console.log("✅ Token valid for user:", link.userId);
    await run("DELETE FROM magic_links WHERE token = ?", [token]);
    const sessionToken = await createSession(link.userId);
    if (link.claimReviewId) {
        const review = await queryOne("SELECT * FROM reviews WHERE id = ?", [link.claimReviewId]);
        if (review && !review.userId) {
            await run("UPDATE reviews SET userId = ? WHERE id = ?", [link.userId, link.claimReviewId]);
            await addReviewToUser(link.userId, link.claimReviewId);
        }
    }
    res.setHeader("Set-Cookie", `sessionToken=${sessionToken}; Path=/; Max-Age=2592000; HttpOnly`);
    res.redirect("/dashboard");
});

app.post("/save-review/:id", async (req, res) => {
    if (!req.user) return res.status(401).json({ error: "Please sign in to save reviews" });
    await addSavedReview(req.user.id, req.params.id);
    res.json({ success: true });
});

app.post("/save-ad/:id", async (req, res) => {
    if (!req.user) return res.status(401).json({ error: "Please sign in to save ads" });
    await addSavedAd(req.user.id, req.params.id);
    res.json({ success: true });
});

app.post("/unsave-ad/:id", async (req, res) => {
    if (!req.user) return res.status(401).json({ error: "Please sign in" });
    await removeSavedAd(req.user.id, req.params.id);
    res.json({ success: true });
});

app.post("/unsave-review/:id", async (req, res) => {
    if (!req.user) return res.status(401).json({ error: "Please sign in" });
    await removeSavedReview(req.user.id, req.params.id);
    res.json({ success: true });
});

app.get("/api/saved-ads", async (req, res) => {
    if (!req.user) return res.status(401).json({ error: "Not authenticated" });
    res.json(await getSavedAds(req.user.id));
});

app.get("/api/current-user", (req, res) => {
    if (req.user) res.json({ id: req.user.id, email: req.user.email });
    else res.json({ error: "Not logged in" });
});

app.get("/api/saved-reviews", async (req, res) => {
    if (!req.user) return res.status(401).json({ error: "Not authenticated" });
    const savedReviewIds = await getSavedReviews(req.user.id);
    const allReviews = await getReviews();
    const savedReviews = allReviews.filter(r => savedReviewIds.includes(r.id.toString()));
    const groupedBySchool = {};
    savedReviews.forEach(review => {
        if (!groupedBySchool[review.schoolName]) groupedBySchool[review.schoolName] = [];
        groupedBySchool[review.schoolName].push(review);
    });
    res.json({ groupedBySchool });
});

app.get("/school/:name/noticeboard", async (req, res) => {
    const schoolName = decodeURIComponent(req.params.name);
    const page = parseInt(req.query.page) || 1;
    const limit = 12;
    const offset = (page - 1) * limit;
    const filter = req.query.filter || 'all';
    const sort = req.query.sort || 'newest';
    const schoolDetails = schoolsData.find(school => school.name.toLowerCase() === schoolName.toLowerCase()) || { name: schoolName };
    let allAds = await getAdsBySchool(schoolName);
    
    allAds = allAds.map(ad => {
        return { ...ad, isSchoolVerified: false };
    });
    
    if (filter === 'free') allAds = allAds.filter(ad => ad.isFree == 1 || ad.isFree === true);
    else if (filter === 'wanted') allAds = allAds.filter(ad => ad.isWanted == 1 || ad.isWanted === true);
    else if (filter === 'schools') allAds = allAds.filter(ad => ad.isSchoolVerified === true);
    else if (filter !== 'all') allAds = allAds.filter(ad => ad.category === filter);
    
    if (sort === 'price-low') allAds.sort((a, b) => parseFloat(a.price) - parseFloat(b.price));
    else if (sort === 'price-high') allAds.sort((a, b) => parseFloat(b.price) - parseFloat(a.price));
    else allAds.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    const totalAds = allAds.length;
    const totalPages = Math.ceil(totalAds / limit);
    const paginatedAds = allAds.slice(offset, offset + limit);
    let adsWithMessageStatus = paginatedAds;
    if (req.user) {
        const allMessages = await getMessagesForUser(req.user.id);
        adsWithMessageStatus = paginatedAds.map(ad => ({ ...ad, hasConversation: allMessages.some(msg => msg.adId === ad.id) }));
    }
    res.render("noticeboard", { ads: adsWithMessageStatus, title: `${schoolName} Noticeboard - SchoolSentiment`, schoolName: schoolName, schoolDetails: schoolDetails, currentUser: req.user || null, currentPage: "noticeboard", pagination: { currentPage: page, totalPages: totalPages, totalAds: totalAds, limit: limit }, currentFilter: filter, currentSort: sort });
});

app.get("/post-ad/:schoolName", (req, res) => {
    if (!req.user) return res.redirect("/signin?message=Please sign in to post an ad");
    res.render("post-ad", { title: "Post an Ad - SchoolSentiment", schoolName: decodeURIComponent(req.params.schoolName), currentUser: req.user, currentPage: "noticeboard" });
});

app.post("/submit-ad", upload.array("photos", 5), async (req, res) => {
    if (!req.user) return res.status(401).send("Please sign in to post an ad");
    if (req.user.banned === 1) return res.status(403).send(`<h1>Account Suspended</h1><p>Your account has been suspended. You cannot post new ads.</p><a href="/dashboard">Back to Dashboard</a>`);
    
    console.log("=== DEBUG: submit-ad route hit ===");
    console.log("req.files:", req.files ? req.files.length : 0);
    if (req.files && req.files.length > 0) {
        for (let i = 0; i < req.files.length; i++) {
            console.log(`File ${i}:`, req.files[i].originalname, req.files[i].filename);
        }
    }
    
    let imageUrls = [];
    if (req.files && req.files.length > 0) {
        for (const file of req.files) {
            try {
                const ExifImage = require('exif').ExifImage;
                const tempPath = file.path + '.tmp';
                
                // Read and remove EXIF using exif library
                try {
                    new ExifImage({ image: file.path }, function(error, exifData) {
                        if (error) {
                            console.log('No EXIF data found, continuing...');
                        } else {
                            console.log('EXIF data found and will be stripped');
                        }
                    });
                } catch (e) {
                    // No EXIF, continue
                }
                
                // Re-encode with sharp to strip all metadata
                const metadata = await sharp(file.path).metadata();
                let pipeline = sharp(file.path);
                
                if (metadata.width > 1200 || metadata.height > 1200) {
                    pipeline = pipeline.resize(1200, 1200, { fit: 'inside', withoutEnlargement: true });
                }
                
                // Save with no metadata
                await pipeline
                    .withMetadata(false)
                    .toFile(tempPath);
                
                // Replace the original file with the clean one
                fs.renameSync(tempPath, file.path);
                imageUrls.push("/uploads/ads/" + file.filename);
                // Strip ALL EXIF using exifr
                try {
                    await stripExifFromFile(file.path);
                } catch (exifErr) {
                    console.error("EXIF strip error:", exifErr);
                }
                console.log("✅ EXIF stripped from:", file.filename);
                } catch (err) { 
                console.error("Image processing error:", err);
                // If error, still try to use the original
                imageUrls.push("/uploads/ads/" + file.filename);
                // Strip ALL EXIF using exifr
                try {
                    await stripExifFromFile(file.path);
                } catch (exifErr) {
                    console.error("EXIF strip error:", exifErr);
                }
            }
        }
    }
    
    console.log("imageUrls saved:", imageUrls);
    
    const adData = { 
        schoolName: req.body.schoolName, 
        title: sanitizeInput(req.body.title), 
        description: sanitizeInput(req.body.description), 
        category: req.body.category, 
        price: req.body.isWanted ? (req.body.price || '') : req.body.price, 
        isWanted: req.body.isWanted === 'true' || req.body.isWanted === 'on' || req.body.isWanted === true, 
        condition: req.body.condition, 
        userId: req.user.id, 
        userEmail: req.user.email, 
        imageUrl: imageUrls.length > 0 ? imageUrls[0] : null,
        imageUrls: imageUrls
    };
    const ad = await createAd(adData);
    
    const adFollowers = await getFollowersOfSchool(req.body.schoolName);
    if (adFollowers.length > 0) {
        const priceDisplay = adData.isWanted ? (adData.price && adData.price !== '' && adData.price !== '0' ? 'Wanted - £' + adData.price : 'Wanted - Make offer') : (adData.isFree ? 'FREE' : (adData.price ? '£' + adData.price : 'Free'));
        for (const follower of adFollowers) {
            if (follower.email !== req.user.email) {
                try {
                    await run(
                        `INSERT INTO notifications (userId, type, schoolName, adId, message, createdAt, isRead) VALUES (?, 'ad', ?, ?, 'New ad posted for school you follow', NOW(), 0)`,
                        [follower.id, req.body.schoolName, ad.id]
                    );
                    await sendEmail(follower.email, `New Item at ${req.body.schoolName}`, `
                            <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 580px; margin: 0 auto; padding: 0; border: 1px solid #e2e8f0; border-radius: 16px; background: #ffffff; box-shadow: 0 4px 6px rgba(0,0,0,0.05);">
                                <div style="text-align: center; padding: 30px 24px 24px 24px; background: linear-gradient(135deg, #1e293b 0%, #0f172a 100%); border-radius: 16px 16px 0 0;">
                                    <img src="https://schoolsentiment.co.uk/logo/SchoolSentiment_white_transparency.png" alt="School Sentiment" style="max-height: 65px; width: auto; margin-bottom: 12px;">
                                    <div style="color: #94a3b8; font-size: 13px; letter-spacing: 2px; text-transform: uppercase; font-weight: 600;">New Listing</div>
                                    <h2 style="color: #ffffff; margin: 6px 0 0 0; font-size: 22px; font-weight: 700;">${req.body.schoolName}</h2>
                                </div>
                                <div style="padding: 28px 24px;">
                                    <div style="display: flex; align-items: center; margin-bottom: 6px;">
                                        <span style="color: #4f46e5; font-size: 18px; margin-right: 10px;">◈</span>
                                        <span style="font-size: 15px; color: #1e293b;"><strong>School:</strong> ${req.body.schoolName}</span>
                                    </div>
                                    <div style="display: flex; align-items: center; margin-bottom: 6px;">
                                        <span style="color: #4f46e5; font-size: 18px; margin-right: 10px;">◈</span>
                                        <span style="font-size: 15px; color: #1e293b;"><strong>Item:</strong> ${adData.title}</span>
                                    </div>
                                    <div style="display: flex; align-items: center; margin-bottom: 6px;">
                                        <span style="color: #4f46e5; font-size: 18px; margin-right: 10px;">◈</span>
                                        <span style="font-size: 15px; color: #1e293b;"><strong>Price:</strong> ${priceDisplay}</span>
                                    </div>
                                    ${adData.description ? `<div style="background: #f8fafc; padding: 16px 18px; border-radius: 10px; margin: 16px 0 20px 0; border-left: 4px solid #4f46e5;"><p style="margin: 0; color: #475569; font-size: 14px; line-height: 1.6; font-style: italic;">"${adData.description.substring(0, 150)}${adData.description.length > 150 ? '...' : ''}"</p></div>` : ''}
                                    <a href="https://schoolsentiment.co.uk/school/${encodeURIComponent(req.body.schoolName)}/noticeboard" style="display: inline-block; background: #4f46e5; color: white; padding: 12px 28px; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 15px;">View Noticeboard →</a>
                                </div>
                                <div style="border-top: 1px solid #e2e8f0; padding: 16px 24px; text-align: center; font-size: 11px; color: #94a3b8; background: #f8fafc; border-radius: 0 0 16px 16px;">
                                    <p style="margin: 0;">You received this because you follow ${req.body.schoolName} on School Sentiment</p>
                                    <p style="margin: 6px 0 0 0;">
                                        <a href="https://schoolsentiment.co.uk/school/${encodeURIComponent(req.body.schoolName)}" style="color: #4f46e5; text-decoration: none;">Unfollow this school</a> · 
                                        <a href="https://schoolsentiment.co.uk/dashboard" style="color: #4f46e5; text-decoration: none;">Dashboard</a>
                                    </p>
                                    <p style="margin: 8px 0 0 0; color: #cbd5e1;">© 2026 School Sentiment</p>
                                </div>
                            </div>`);
                } catch(emailErr) { console.error("Failed to send email:", emailErr.message); }
            }
        }
    }
    try {
        // The ad is already created at this point
        res.json({ success: true, message: "Ad posted successfully", redirect: "/dashboard?message=Ad posted successfully" });
    } catch (err) {
        console.error("Error in submit-ad:", err.message);
        // Even if there's an error, the ad was already created, so redirect anyway
        res.json({ success: true, message: "Ad posted successfully", redirect: "/dashboard?message=Ad posted successfully" });
    }
});

app.get("/messages", async (req, res) => {
    if (!req.user) return res.redirect("/signin?message=Please sign in to view your messages");
    const adFilter = req.query.ad;
    const allMessages = await getMessagesForUser(req.user.id);
    const allAds = await getAds();
    let filteredMessages = allMessages;
    if (adFilter) filteredMessages = allMessages.filter(msg => msg.adId === adFilter);
    const conversations = {};
    filteredMessages.forEach(msg => {
        const otherUserId = msg.fromUserId === req.user.id ? msg.toUserId : msg.fromUserId;
        const ad = allAds.find(a => a.id === msg.adId);
        const key = `${msg.adId}_${otherUserId}`;
        if (!conversations[key]) conversations[key] = { adId: msg.adId, adTitle: ad ? ad.title : 'Unknown Ad', adPublicId: ad ? ad.publicId : null, adImage: ad && ad.imageUrls && ad.imageUrls.length > 0 ? ad.imageUrls[0] : null, schoolName: ad ? ad.schoolName : 'Unknown School', otherUserId: otherUserId, lastMessage: msg.message, lastMessageAt: msg.createdAt, isRead: msg.toUserId === req.user.id ? msg.isRead : true, messages: [] };
        conversations[key].messages.push(msg);
        if (new Date(msg.createdAt) > new Date(conversations[key].lastMessageAt)) { conversations[key].lastMessage = msg.message; conversations[key].lastMessageAt = msg.createdAt; }
    });
    const sorted = Object.values(conversations).sort((a, b) => new Date(b.lastMessageAt) - new Date(a.lastMessageAt));
    if (sorted.length === 0 && !adFilter) return res.render("messages", { title: "My Messages - SchoolSentiment", conversations: [], schoolName: null, currentUser: req.user, currentPage: "messages" });
    if (adFilter && sorted.length === 1) return res.redirect("/messages/" + sorted[0].adId + "/" + sorted[0].otherUserId);
    if (adFilter && sorted.length === 0) { const ad = allAds.find(a => a.id === adFilter); return res.render("messages", { title: "My Messages - SchoolSentiment", conversations: [], noConversationsForAd: true, ad: ad, schoolName: ad ? ad.schoolName : null, currentUser: req.user, currentPage: "messages" }); }
    res.render("messages", { title: "My Messages - SchoolSentiment", conversations: sorted, currentUser: req.user, currentPage: "messages" });
});

app.get("/messages/:adId/:userId", async (req, res) => {
    if (!req.user) return res.redirect("/signin?message=Please sign in to view messages");
    const adId = req.params.adId;
    const otherUserId = req.params.userId;
    const allMessages = await getMessagesForUser(req.user.id);
    const conversationMessages = allMessages.filter(m => m.adId === adId && (m.fromUserId === otherUserId || m.toUserId === otherUserId));
    conversationMessages.forEach(msg => { if (msg.toUserId === req.user.id && !msg.isRead) msg.isRead = true; });
    const ad = await getAdById(adId);
    if (!ad) {
        return res.status(404).send("Ad not found");
    }
    res.render("conversation", { title: "Conversation - SchoolSentiment", messages: conversationMessages, ad: ad, otherUserId: otherUserId, currentUser: req.user, currentPage: "messages" });
});

app.post("/send-reply/:adId/:userId", async (req, res) => {
    if (!req.user) return res.status(401).json({ error: "Please sign in" });
    if (!req.body.message || req.body.message.trim() === '') return res.status(400).json({ error: "Message cannot be empty" });
    const ad = await getAdById(req.params.adId);
    if (!ad) return res.status(404).json({ error: "Ad not found" });
    await createMessage({ adId: req.params.adId, fromUserId: req.user.id, toUserId: req.params.userId, message: sanitizeInput(req.body.message), createdAt: new Date().toISOString(), isRead: false });
    
    await run(
        `INSERT INTO notifications (userId, type, adId, schoolName, message, createdAt, isRead) VALUES (?, 'message', ?, ?, 'You have a new message about your ad', NOW(), 0)`,
        [req.params.userId, req.params.adId, ad.schoolName]
    );
    
    res.json({ success: true, message: "Message sent successfully" });
});

app.post("/message-about-ad/:adId", async (req, res) => {
    if (!req.user) return res.status(401).json({ error: "Please sign in to send messages" });
    const ad = await getAdById(req.params.adId);
    if (!ad) return res.status(404).json({ error: "Ad not found" });
    await createMessage({ adId: ad.id, fromUserId: req.user.id, toUserId: ad.userId, message: sanitizeInput(req.body.message), createdAt: new Date().toISOString(), isRead: false });
    
    await run(
        `INSERT INTO notifications (userId, type, adId, schoolName, message, createdAt, isRead) VALUES (?, 'message', ?, ?, 'Someone is interested in your ad', NOW(), 0)`,
        [ad.userId, ad.id, ad.schoolName]
    );
    
    res.json({ success: true, message: "Message sent successfully" });
});

app.get("/saved-reviews", async (req, res) => {
    if (!req.user) return res.redirect("/signin?message=Please sign in to view your saved reviews");
    const allReviews = await getReviews();
    const savedReviewIds = await getSavedReviews(req.user.id);
    const savedReviews = allReviews.filter(r => savedReviewIds.includes(r.id.toString()));
    const groupedBySchool = {};
    savedReviews.forEach(review => { if (!groupedBySchool[review.schoolName]) groupedBySchool[review.schoolName] = []; groupedBySchool[review.schoolName].push(review); });
    res.render("saved-reviews", { title: "My Saved Reviews - SchoolSentiment", groupedBySchool: groupedBySchool, currentUser: req.user, currentPage: "saved-reviews" });
});

app.get("/post-ad/", (req, res) => {
    if (!req.user) return res.redirect("/signin?message=Please sign in to post an ad");
    res.render("post-ad", { title: "Post an Ad - SchoolSentiment", schoolName: "", currentUser: req.user, currentPage: "noticeboard" });
});

app.post("/delete-ad/:id", async (req, res) => {
    if (!req.user) return res.status(401).send("Unauthorized");
    const deleted = await deleteAd(req.params.id, req.user.id);
    if (deleted) res.redirect("/dashboard?message=Ad deleted successfully");
    else res.status(404).send("Ad not found or you don't have permission");
});

app.get("/edit-ad/:id", async (req, res) => {
    if (!req.user) return res.redirect("/signin?message=Please sign in to edit this ad");
    const ad = await getAdById(req.params.id);
    if (!ad || ad.userId !== req.user.id) return res.redirect("/dashboard?message=Ad not found or you don't have permission");
    res.render("edit-ad", { title: "Edit Ad - SchoolSentiment", ad: ad, currentUser: req.user, currentPage: "dashboard" });
});

app.post("/update-ad/:id", upload.array("photos", 5), async (req, res) => {
    if (!req.user) return res.status(401).send("Unauthorized");
    const ad = await getAdById(req.params.id);
    if (!ad || ad.userId !== req.user.id) return res.redirect("/dashboard?message=Ad not found or permission denied");
    
    let imageUrls = [];
    let imageOrder = null;
    
    if (req.body.imageOrder) {
        try {
            imageOrder = JSON.parse(req.body.imageOrder);
            console.log("Image order received:", imageOrder);
        } catch(e) {
            console.log("Failed to parse imageOrder:", e.message);
        }
    }
    
    if (req.files && req.files.length > 0) {
        for (const file of req.files) {
            try {
                const ExifImage = require('exif').ExifImage;
                const tempPath = file.path + '.tmp';
                
                // Read and remove EXIF using exif library
                try {
                    new ExifImage({ image: file.path }, function(error, exifData) {
                        if (error) {
                            console.log('No EXIF data found, continuing...');
                        } else {
                            console.log('EXIF data found and will be stripped');
                        }
                    });
                } catch (e) {
                    // No EXIF, continue
                }
                
                // Re-encode with sharp to strip all metadata
                const metadata = await sharp(file.path).metadata();
                let pipeline = sharp(file.path);
                
                if (metadata.width > 1200 || metadata.height > 1200) {
                    pipeline = pipeline.resize(1200, 1200, { fit: 'inside', withoutEnlargement: true });
                }
                
                // Save with no metadata
                await pipeline
                    .withMetadata(false)
                    .toFile(tempPath);
                
                // Replace the original file with the clean one
                fs.renameSync(tempPath, file.path);
                imageUrls.push("/uploads/ads/" + file.filename);
                console.log("✅ EXIF stripped from:", file.filename);
            } catch (err) { 
                console.error("Image processing error:", err);
                // If error, still try to use the original
                imageUrls.push("/uploads/ads/" + file.filename);
            }
        }
    }
    
    const replaceImages = req.body.replaceImages === 'true';
    
    const adData = { 
        title: req.body.title, 
        description: req.body.description, 
        category: req.body.category, 
        price: req.body.price, 
        isFree: req.body.price === "0" || req.body.price === "free" || req.body.price === "FREE", 
        isWanted: req.body.isWanted === 'true' || req.body.isWanted === 'on', 
        condition: req.body.condition, 
        imageUrls: imageUrls,
        replaceImages: replaceImages
    };
    
    if (imageOrder && imageOrder.length > 0) {
        await deleteAdImagesByAdId(req.params.id);
        await saveAdImages(req.params.id, imageOrder);
        console.log("Updated image order for ad:", req.params.id);
    }
    
    await updateAd(req.params.id, adData);
    res.json({ success: true, message: "Ad updated successfully", redirect: "/dashboard?message=Ad updated successfully" });
});

app.get("/search-noticeboard", (req, res) => {
    const schoolName = req.query.school;
    if (!schoolName) return res.redirect("/noticeboard");
    const matchedSchool = schoolsData.find(s => s.name.toLowerCase().includes(schoolName.toLowerCase()));
    if (matchedSchool) res.redirect(`/school/${encodeURIComponent(matchedSchool.name)}/noticeboard`);
    else res.redirect("/noticeboard?error=School not found");
});

app.get("/noticeboard", async (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = 12;
    const offset = (page - 1) * limit;
    const filter = req.query.filter || 'all';
    const sort = req.query.sort || 'newest';
    let allAds = await getAds();
    // Attach images to each ad
    for (let i = 0; i < allAds.length; i++) {
        try {
            const images = await query("SELECT * FROM ad_images WHERE adId = ? ORDER BY position ASC", [allAds[i].id]);
            allAds[i].images = images;
            allAds[i].imageUrls = images.map(img => img.imageUrl);
            if (images.length === 0 && allAds[i].imageUrl) {
                allAds[i].imageUrls = [allAds[i].imageUrl];
            }
        } catch(e) {
            console.error("Error attaching images to ad:", e.message);
            allAds[i].imageUrls = [];
            allAds[i].images = [];
        }
    }
    let activeAds = allAds.filter(ad => ad.status === 'active');
    
    activeAds = activeAds.map(ad => {
        return { ...ad, isSchoolVerified: false };
    });
    
    if (filter === 'free') activeAds = activeAds.filter(ad => ad.isFree == 1 || ad.isFree === true);
    else if (filter === 'wanted') activeAds = activeAds.filter(ad => ad.isWanted == 1 || ad.isWanted === true);
    else if (filter === 'schools') activeAds = activeAds.filter(ad => ad.isSchoolVerified === true);
    else if (filter !== 'all') activeAds = activeAds.filter(ad => ad.category === filter);
    
    if (sort === 'price-low') activeAds.sort((a, b) => parseFloat(a.price) - parseFloat(b.price));
    else if (sort === 'price-high') activeAds.sort((a, b) => parseFloat(b.price) - parseFloat(a.price));
    else activeAds.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    const totalAds = activeAds.length;
    const totalPages = Math.ceil(totalAds / limit);
    const paginatedAds = activeAds.slice(offset, offset + limit);
    res.render("noticeboard-landing", { title: "School Noticeboard - SchoolSentiment", currentUser: req.user || null, currentPage: "noticeboard", ads: paginatedAds, pagination: { currentPage: page, totalPages: totalPages, totalAds: totalAds, limit: limit }, currentFilter: filter, currentSort: sort });
});

app.get("/ad/:id", async (req, res) => {
    const ad = await getAdById(req.params.id);
    if (!ad || ad.status !== 'active') return res.status(404).send(`<h1>Ad not found</h1><p>The ad you're looking for doesn't exist or has been removed.</p><a href="/noticeboard">Back to Noticeboard</a>`);
    res.render("ad-detail", { title: ad.title + " - SchoolSentiment", currentPage: "noticeboard", ad: ad, currentUser: req.user || null });
});

app.get("/api/ads", async (req, res) => {
    const allAds = await getAds();
    res.json(allAds);
});

app.post("/follow-school/:schoolName", async (req, res) => {
    if (!req.user) return res.status(401).json({ error: "Please sign in to follow schools" });
    await addFollowedSchool(req.user.id, decodeURIComponent(req.params.schoolName));
    res.json({ success: true });
});

app.post("/unfollow-school/:schoolName", async (req, res) => {
    if (!req.user) return res.status(401).json({ error: "Please sign in" });
    await removeFollowedSchool(req.user.id, decodeURIComponent(req.params.schoolName));
    res.json({ success: true });
});

app.get("/api/followed-schools", async (req, res) => {
    if (!req.user) return res.status(401).json({ error: "Not authenticated" });
    res.json(await getFollowedSchools(req.user.id));
});

app.get("/admin/get-review-status", async (req, res) => {
    const { reviewId } = req.query;
    if (!reviewId) return res.status(400).json({ error: "Review ID required" });
    const review = await queryOne("SELECT hidden FROM reviews WHERE id = ?", [reviewId]);
    res.json({ hidden: review ? (review.hidden === 1) : false });
});

app.post("/api/follow-school", async (req, res) => {
    if (!req.user) return res.status(401).json({ error: "Please sign in" });
    const { schoolName } = req.body;
    if (!schoolName) return res.status(400).json({ error: "School name required" });
    const user = await queryOne("SELECT followedSchools FROM users WHERE id = ?", [req.user.id]);
    let followedSchools = [];
    try {
        if (typeof user.followedSchools === 'string') {
            if (user.followedSchools.includes(',')) {
                followedSchools = user.followedSchools.split(',').map(s => s.trim()).filter(s => s);
            } else {
                followedSchools = JSON.parse(user.followedSchools || '[]');
            }
        } else if (Array.isArray(user.followedSchools)) {
            followedSchools = user.followedSchools;
        } else {
            followedSchools = [];
        }
    } catch(e) {
        followedSchools = [];
    }
    if (!followedSchools.includes(schoolName)) {
        followedSchools.push(schoolName);
        await run("UPDATE users SET followedSchools = ? WHERE id = ?", [JSON.stringify(followedSchools), req.user.id]);
    }
    res.json({ success: true, followed: true });
});

app.post("/api/unfollow-school", async (req, res) => {
    if (!req.user) return res.status(401).json({ error: "Please sign in" });
    const { schoolName } = req.body;
    if (!schoolName) return res.status(400).json({ error: "School name required" });
    const user = await queryOne("SELECT followedSchools FROM users WHERE id = ?", [req.user.id]);
    let followedSchools = [];
    try {
        if (typeof user.followedSchools === 'string') {
            if (user.followedSchools.includes(',')) {
                followedSchools = user.followedSchools.split(',').map(s => s.trim()).filter(s => s);
            } else {
                followedSchools = JSON.parse(user.followedSchools || '[]');
            }
        } else if (Array.isArray(user.followedSchools)) {
            followedSchools = user.followedSchools;
        } else {
            followedSchools = [];
        }
    } catch(e) {
        followedSchools = [];
    }
    followedSchools = followedSchools.filter(s => s !== schoolName);
    await run("UPDATE users SET followedSchools = ? WHERE id = ?", [JSON.stringify(followedSchools), req.user.id]);
    res.json({ success: true, followed: false });
});

app.get("/api/notifications/unread-count", async (req, res) => {
    if (!req.user) return res.status(401).json({ error: "Not authenticated" });
    const result = await queryOne("SELECT COUNT(*) as count FROM notifications WHERE userId = ? AND isRead = 0", [req.user.id]);
    res.json({ count: result.count });
});

app.get("/api/notifications", async (req, res) => {
    if (!req.user) return res.status(401).json({ error: "Not authenticated" });
    const limit = parseInt(req.query.limit) || 20;
    const offset = parseInt(req.query.offset) || 0;
    const notifications = await query(`SELECT * FROM notifications WHERE userId = ? ORDER BY createdAt DESC LIMIT ? OFFSET ?`, [req.user.id, limit, offset]);
    res.json({ notifications });
});

app.post("/api/notifications/mark-read", async (req, res) => {
    if (!req.user) return res.status(401).json({ error: "Not authenticated" });
    const { notificationId } = req.body;
    await run("UPDATE notifications SET isRead = 1 WHERE id = ? AND userId = ?", [notificationId, req.user.id]);
    res.json({ success: true });
});

app.post("/api/notifications/mark-all-read", async (req, res) => {
    if (!req.user) return res.status(401).json({ error: "Not authenticated" });
    await run("UPDATE notifications SET isRead = 1 WHERE userId = ?", [req.user.id]);
    res.json({ success: true });
});

app.get("/sitemap.xml", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "sitemap.xml"));
});

// ========== SCHOOL CLAIM SYSTEM ==========

app.get("/claim-school/:schoolName", async (req, res) => {
    if (!req.user) return res.redirect('/signin');
    const schoolName = decodeURIComponent(req.params.schoolName);
    
    if (req.user.isSchoolStaff === 1) {
        const userRecord = await queryOne("SELECT schoolRepresentative FROM users WHERE id = ?", [req.user.id]);
        if (userRecord && userRecord.schoolRepresentative !== schoolName) {
            return res.send(`<script>alert('You can only claim the school you registered with: ${userRecord.schoolRepresentative}'); window.location.href = '/school/${encodeURIComponent(userRecord.schoolRepresentative)}';</script>`);
        }
    }
    
    const existingVerified = await queryOne("SELECT * FROM verified_schools WHERE schoolName = ?", [schoolName]);
    const existingClaim = await queryOne("SELECT * FROM school_claims WHERE schoolName = ? AND claimantUserId = ? AND status = 'pending'", [schoolName, req.user.id]);
    if (existingVerified) return res.send(`<script>alert('This school is already verified.'); window.location.href = '/school/${encodeURIComponent(schoolName)}';</script>`);
    res.render("claim-school", { title: `Claim ${schoolName} - SchoolSentiment`, schoolName: schoolName, user: req.user, existingClaim: existingClaim, currentPage: "claim" });
});

app.post("/submit-claim", async (req, res) => {
    if (!req.user) return res.status(401).send("Please sign in");
    const { schoolName, role } = req.body;
    const claimId = crypto.randomBytes(16).toString("hex");
    const submittedAt = new Date().toISOString();
    const autoVerifyResult = shouldAutoVerify(req.user.email, role);
    const finalStatus = autoVerifyResult.autoVerify ? "approved" : "pending";
    
    const existingVerified = await queryOne("SELECT * FROM verified_schools WHERE schoolName = ?", [schoolName]);
    if (existingVerified) { return res.send(`<script>alert('This school is already verified.'); window.location.href = '/school/${encodeURIComponent(schoolName)}';</script>`); }
    const existingClaim = await queryOne("SELECT * FROM school_claims WHERE schoolName = ? AND claimantUserId = ? AND status = 'pending'", [schoolName, req.user.id]);
    if (existingClaim && finalStatus === "pending") { return res.send(`<script>alert('You have already submitted a claim for this school.'); window.location.href = '/school/${encodeURIComponent(schoolName)}';</script>`); }
    
    const reviewedAt = finalStatus === "approved" ? submittedAt : null;
    const reviewedBy = finalStatus === "approved" ? "system" : null;
    const adminNotes = autoVerifyResult.autoVerify ? `Auto-verified: ${autoVerifyResult.reason}` : null;
    
    await run(
        `INSERT INTO school_claims (id, schoolName, claimantEmail, claimantUserId, role, status, submittedAt, reviewedAt, reviewedBy, adminNotes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [claimId, schoolName, req.user.email, req.user.id, role, finalStatus, submittedAt, reviewedAt, reviewedBy, adminNotes]
    );
    
    if (finalStatus === "approved") {
        await run("INSERT INTO verified_schools (schoolName, verifiedAt, verifiedBy, claimId) VALUES (?, ?, ?, ?)", [schoolName, submittedAt, "system", claimId]);
        console.log(`✅ AUTO-VERIFIED: ${schoolName} for ${req.user.email}`);
    }
    
    const statusMessage = finalStatus === "approved" ? "✅ Your claim has been automatically approved! The school profile now shows a Verified badge." : "⏳ Your claim has been submitted and is pending admin review.";
    if (true) { try { await sendEmail(req.user.email, `School Claim Update: ${schoolName}`, `
                            <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 580px; margin: 0 auto; padding: 0; border: 1px solid #e2e8f0; border-radius: 16px; background: #ffffff; box-shadow: 0 4px 6px rgba(0,0,0,0.05);">
                                <div style="text-align: center; padding: 30px 24px 24px 24px; background: linear-gradient(135deg, #1e293b 0%, #0f172a 100%); border-radius: 16px 16px 0 0;">
                                    <img src="https://schoolsentiment.co.uk/logo/SchoolSentiment_white_transparency.png" alt="School Sentiment" style="max-height: 65px; width: auto; margin-bottom: 12px;">
                                    <div style="color: #94a3b8; font-size: 13px; letter-spacing: 2px; text-transform: uppercase; font-weight: 600;">School Claim</div>
                                    <h2 style="color: #ffffff; margin: 6px 0 0 0; font-size: 22px; font-weight: 700;">${finalStatus === 'approved' ? '✅ Claim Approved!' : '⏳ Claim Received'}</h2>
                                </div>
                                <div style="padding: 28px 24px;">
                                    <p style="font-size: 15px; color: #1e293b; margin: 0 0 6px 0;"><strong>School:</strong> ${schoolName}</p>
                                    <p style="font-size: 15px; color: #1e293b; margin: 0 0 6px 0;"><strong>Status:</strong> ${finalStatus === 'approved' ? 'Approved ✅' : 'Pending Review ⏳'}</p>
                                    <div style="background: #f8fafc; padding: 16px 18px; border-radius: 10px; margin: 16px 0 20px 0; border-left: 4px solid #4f46e5;">
                                        <p style="margin: 0; color: #475569; font-size: 14px; line-height: 1.6;">${statusMessage}</p>
                                    </div>
                                    <a href="https://schoolsentiment.co.uk/school/${encodeURIComponent(schoolName)}" style="display: inline-block; background: #4f46e5; color: white; padding: 12px 28px; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 15px;">View School →</a>
                                </div>
                                <div style="border-top: 1px solid #e2e8f0; padding: 16px 24px; text-align: center; font-size: 11px; color: #94a3b8; background: #f8fafc; border-radius: 0 0 16px 16px;">
                                    <p style="margin: 0;">School Sentiment - Honest school reviews from real parents, students, and staff</p>
                                    <p style="margin: 6px 0 0 0;">
                                        <a href="https://schoolsentiment.co.uk" style="color: #4f46e5; text-decoration: none;">Visit Website</a> · 
                                        <a href="https://schoolsentiment.co.uk/privacy" style="color: #4f46e5; text-decoration: none;">Privacy Policy</a>
                                    </p>
                                    <p style="margin: 8px 0 0 0; color: #cbd5e1;">© 2026 School Sentiment</p>
                                </div>
                            </div>`); } catch(e) { console.log("Email error:", e.message); } }
    if (finalStatus === "pending") { try { await sendEmail(process.env.ADMIN_EMAIL || "hubzy@hotmail.com", `🏫 New School Claim: ${schoolName}`, `
                            <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 580px; margin: 0 auto; padding: 0; border: 1px solid #e2e8f0; border-radius: 16px; background: #ffffff; box-shadow: 0 4px 6px rgba(0,0,0,0.05);">
                                <div style="text-align: center; padding: 30px 24px 24px 24px; background: linear-gradient(135deg, #1e293b 0%, #0f172a 100%); border-radius: 16px 16px 0 0;">
                                    <img src="https://schoolsentiment.co.uk/logo/SchoolSentiment_white_transparency.png" alt="School Sentiment" style="max-height: 65px; width: auto; margin-bottom: 12px;">
                                    <div style="color: #94a3b8; font-size: 13px; letter-spacing: 2px; text-transform: uppercase; font-weight: 600;">Admin Alert</div>
                                    <h2 style="color: #ffffff; margin: 6px 0 0 0; font-size: 22px; font-weight: 700;">🏫 New School Claim</h2>
                                </div>
                                <div style="padding: 28px 24px;">
                                    <p style="font-size: 15px; color: #1e293b; margin: 0 0 6px 0;"><strong>School:</strong> ${schoolName}</p>
                                    <p style="font-size: 15px; color: #1e293b; margin: 0 0 6px 0;"><strong>Claimant:</strong> ${req.user.email}</p>
                                    <p style="font-size: 15px; color: #1e293b; margin: 0 0 6px 0;"><strong>Role:</strong> ${role}</p>
                                    <a href="https://schoolsentiment.co.uk/admin/claims" style="display: inline-block; background: #4f46e5; color: white; padding: 12px 28px; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 15px; margin-top: 8px;">Review Claims →</a>
                                </div>
                                <div style="border-top: 1px solid #e2e8f0; padding: 16px 24px; text-align: center; font-size: 11px; color: #94a3b8; background: #f8fafc; border-radius: 0 0 16px 16px;">
                                    <p style="margin: 0;">School Sentiment - Admin Notification</p>
                                    <p style="margin: 6px 0 0 0;">
                                        <a href="https://schoolsentiment.co.uk/admin" style="color: #4f46e5; text-decoration: none;">Admin Dashboard</a>
                                    </p>
                                    <p style="margin: 8px 0 0 0; color: #cbd5e1;">© 2026 School Sentiment</p>
                                </div>
                            </div>`); } catch(e) { console.log("Admin email error:", e.message); } }
    res.send(`<script>alert('${statusMessage.replace(/'/g, "\\'")}'); window.location.href = '/school/${encodeURIComponent(schoolName)}';</script>`);
});

app.post("/submit-reply", async (req, res) => {
    if (!req.user) return res.status(401).json({ error: "Please sign in" });
    const { reviewId, schoolName, responseText } = req.body;
    if (!reviewId || !schoolName || !responseText || responseText.trim() === '') return res.status(400).json({ error: "Missing required fields" });
    
    const verified = await queryOne("SELECT * FROM verified_schools WHERE schoolName = ?", [schoolName]);
    if (!verified) { return res.status(403).json({ error: "Your account is not verified for this school" }); }
    const existingReply = await queryOne("SELECT * FROM school_responses WHERE reviewId = ? AND schoolName = ?", [reviewId, schoolName]);
    if (existingReply) { return res.status(400).json({ error: "A reply already exists for this review" }); }
    const replyId = crypto.randomBytes(16).toString("hex");
    await run(
        `INSERT INTO school_responses (id, reviewId, schoolName, responseText, respondedBy, respondedByUserId, createdAt, hidden) VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
        [replyId, reviewId, schoolName, sanitizeInput(responseText), req.user.email, req.user.id, new Date().toISOString()]
    );
    
    const review = await queryOne("SELECT userId FROM reviews WHERE id = ?", [reviewId]);
    if (review && review.userId) {
        await run(
            `INSERT INTO notifications (userId, type, schoolName, reviewId, message, createdAt, isRead) VALUES (?, 'reply', ?, ?, 'A verified school has responded to your review', NOW(), 0)`,
            [review.userId, schoolName, reviewId]
        );
    }
    
    res.json({ success: true, message: "Reply posted successfully" });
});

app.get("/admin", (req, res) => {
    if (!req.user || !req.user.isAdmin) return res.status(403).send("Admin access required");
    res.render("admin-dashboard", { title: "Admin Dashboard", user: req.user, currentPage: "admin" });
});

app.get("/admin/claims", async (req, res) => {
    if (!req.user || !req.user.isAdmin) return res.status(403).send("Admin access required");
    const pendingClaims = await query("SELECT * FROM school_claims WHERE status = 'pending' ORDER BY submittedAt DESC");
    const approvedClaims = await query("SELECT * FROM school_claims WHERE status = 'approved' ORDER BY reviewedAt DESC");
    const rejectedClaims = await query("SELECT * FROM school_claims WHERE status = 'rejected' ORDER BY reviewedAt DESC");
    res.render("admin-claims", { title: "Manage School Claims", pendingClaims: pendingClaims, approvedClaims: approvedClaims, rejectedClaims: rejectedClaims, user: req.user, currentPage: "admin" });
});

app.post("/admin/approve-claim", async (req, res) => {
    if (!req.user || !req.user.isAdmin) return res.status(403).json({ error: "Unauthorized" });
    const { claimId, schoolName } = req.body;
    const existingVerified = await queryOne("SELECT * FROM verified_schools WHERE schoolName = ?", [schoolName]);
    if (existingVerified) { return res.status(400).json({ error: "School already has an approved claim" }); }
    const existingApprovedClaim = await queryOne("SELECT * FROM school_claims WHERE schoolName = ? AND status = 'approved'", [schoolName]);
    if (existingApprovedClaim) { return res.status(400).json({ error: "Another claim for this school is already approved" }); }
    await run("UPDATE school_claims SET status = 'approved', reviewedAt = ?, reviewedBy = ? WHERE id = ?", [new Date().toISOString(), req.user.id, claimId]);
    await run("INSERT INTO verified_schools (schoolName, verifiedAt, verifiedBy, claimId) VALUES (?, ?, ?, ?)", [schoolName, new Date().toISOString(), req.user.id, claimId]);
    const claim = await queryOne("SELECT claimantEmail, claimantUserId FROM school_claims WHERE id = ?", [claimId]);
    
    if (claim && claim.claimantUserId) {
        await run(
            `INSERT INTO notifications (userId, type, schoolName, message, createdAt, isRead) VALUES (?, 'claim', ?, 'Your claim for ${schoolName} has been approved! You can now reply to reviews.', NOW(), 0)`,
            [claim.claimantUserId, schoolName]
        );
    }
    
    if (claim) { sendEmail(claim.claimantEmail, `✅ Claim Approved for ${schoolName}`, `
                            <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 580px; margin: 0 auto; padding: 0; border: 1px solid #e2e8f0; border-radius: 16px; background: #ffffff; box-shadow: 0 4px 6px rgba(0,0,0,0.05);">
                                <div style="text-align: center; padding: 30px 24px 24px 24px; background: linear-gradient(135deg, #1e293b 0%, #0f172a 100%); border-radius: 16px 16px 0 0;">
                                    <img src="https://schoolsentiment.co.uk/logo/SchoolSentiment_white_transparency.png" alt="School Sentiment" style="max-height: 65px; width: auto; margin-bottom: 12px;">
                                    <div style="color: #94a3b8; font-size: 13px; letter-spacing: 2px; text-transform: uppercase; font-weight: 600;">School Claim</div>
                                    <h2 style="color: #ffffff; margin: 6px 0 0 0; font-size: 22px; font-weight: 700;">✅ Claim Approved!</h2>
                                </div>
                                <div style="padding: 28px 24px;">
                                    <p style="font-size: 15px; color: #1e293b; margin: 0 0 6px 0;"><strong>School:</strong> ${schoolName}</p>
                                    <p style="font-size: 15px; color: #1e293b; margin: 0 0 6px 0;"><strong>Status:</strong> Approved ✅</p>
                                    <div style="background: #f8fafc; padding: 16px 18px; border-radius: 10px; margin: 16px 0 20px 0; border-left: 4px solid #4f46e5;">
                                        <p style="margin: 0; color: #475569; font-size: 14px; line-height: 1.6;">Congratulations! Your claim for <strong>${schoolName}</strong> has been approved. You can now reply to reviews as a verified school representative.</p>
                                    </div>
                                    <a href="https://schoolsentiment.co.uk/school/${encodeURIComponent(schoolName)}" style="display: inline-block; background: #4f46e5; color: white; padding: 12px 28px; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 15px;">View School →</a>
                                </div>
                                <div style="border-top: 1px solid #e2e8f0; padding: 16px 24px; text-align: center; font-size: 11px; color: #94a3b8; background: #f8fafc; border-radius: 0 0 16px 16px;">
                                    <p style="margin: 0;">School Sentiment - Honest school reviews from real parents, students, and staff</p>
                                    <p style="margin: 6px 0 0 0;">
                                        <a href="https://schoolsentiment.co.uk" style="color: #4f46e5; text-decoration: none;">Visit Website</a> · 
                                        <a href="https://schoolsentiment.co.uk/privacy" style="color: #4f46e5; text-decoration: none;">Privacy Policy</a>
                                    </p>
                                    <p style="margin: 8px 0 0 0; color: #cbd5e1;">© 2026 School Sentiment</p>
                                </div>
                            </div>`).catch(e => console.log("Email error:", e.message)); }
    res.json({ success: true });
});

app.post("/admin/reject-claim", async (req, res) => {
    if (!req.user || !req.user.isAdmin) return res.status(403).json({ error: "Unauthorized" });
    const { claimId, schoolName, rejectionReason } = req.body;
    await run("UPDATE school_claims SET status = 'rejected', reviewedAt = ?, reviewedBy = ?, adminNotes = ? WHERE id = ?", [new Date().toISOString(), req.user.id, rejectionReason || null, claimId]);
    const claim = await queryOne("SELECT claimantEmail, claimantUserId FROM school_claims WHERE id = ?", [claimId]);
    
    if (claim && claim.claimantUserId) {
        const reasonText = rejectionReason ? ` Reason: ${rejectionReason}` : '';
        await run(
            `INSERT INTO notifications (userId, type, schoolName, message, createdAt, isRead) VALUES (?, 'claim', ?, 'Your claim for ${schoolName} has been rejected.${reasonText}', NOW(), 0)`,
            [claim.claimantUserId, schoolName]
        );
    }
    
    if (claim) { sendEmail(claim.claimantEmail, `Update on Your Claim for ${schoolName}`, `
                            <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 580px; margin: 0 auto; padding: 0; border: 1px solid #e2e8f0; border-radius: 16px; background: #ffffff; box-shadow: 0 4px 6px rgba(0,0,0,0.05);">
                                <div style="text-align: center; padding: 30px 24px 24px 24px; background: linear-gradient(135deg, #1e293b 0%, #0f172a 100%); border-radius: 16px 16px 0 0;">
                                    <img src="https://schoolsentiment.co.uk/logo/SchoolSentiment_white_transparency.png" alt="School Sentiment" style="max-height: 65px; width: auto; margin-bottom: 12px;">
                                    <div style="color: #94a3b8; font-size: 13px; letter-spacing: 2px; text-transform: uppercase; font-weight: 600;">School Claim</div>
                                    <h2 style="color: #ffffff; margin: 6px 0 0 0; font-size: 22px; font-weight: 700;">❌ Claim Update</h2>
                                </div>
                                <div style="padding: 28px 24px;">
                                    <p style="font-size: 15px; color: #1e293b; margin: 0 0 6px 0;"><strong>School:</strong> ${schoolName}</p>
                                    <p style="font-size: 15px; color: #1e293b; margin: 0 0 6px 0;"><strong>Status:</strong> Rejected ❌</p>
                                    ${rejectionReason ? `<div style="background: #f8fafc; padding: 16px 18px; border-radius: 10px; margin: 16px 0 20px 0; border-left: 4px solid #ef4444;"><p style="margin: 0; color: #475569; font-size: 14px; line-height: 1.6;"><strong>Reason:</strong> ${rejectionReason}</p></div>` : `<div style="background: #f8fafc; padding: 16px 18px; border-radius: 10px; margin: 16px 0 20px 0; border-left: 4px solid #ef4444;"><p style="margin: 0; color: #475569; font-size: 14px; line-height: 1.6;">Your claim for <strong>${schoolName}</strong> could not be approved at this time.</p></div>`}
                                    <p style="font-size: 14px; color: #64748b; margin: 0 0 4px 0;">If you believe this is an error, please contact us.</p>
                                    <a href="https://schoolsentiment.co.uk/contact" style="display: inline-block; background: #4f46e5; color: white; padding: 12px 28px; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 15px; margin-top: 8px;">Contact Support</a>
                                </div>
                                <div style="border-top: 1px solid #e2e8f0; padding: 16px 24px; text-align: center; font-size: 11px; color: #94a3b8; background: #f8fafc; border-radius: 0 0 16px 16px;">
                                    <p style="margin: 0;">School Sentiment - Honest school reviews from real parents, students, and staff</p>
                                    <p style="margin: 6px 0 0 0;">
                                        <a href="https://schoolsentiment.co.uk" style="color: #4f46e5; text-decoration: none;">Visit Website</a> · 
                                        <a href="https://schoolsentiment.co.uk/privacy" style="color: #4f46e5; text-decoration: none;">Privacy Policy</a>
                                    </p>
                                    <p style="margin: 8px 0 0 0; color: #cbd5e1;">© 2026 School Sentiment</p>
                                </div>
                            </div>`).catch(e => console.log("Email error:", e.message)); }
    res.json({ success: true });
});

app.post("/admin/revoke-verification", async (req, res) => {
    if (!req.user || !req.user.isAdmin) return res.status(403).json({ error: "Unauthorized" });
    const { schoolName } = req.body;
    await run("DELETE FROM verified_schools WHERE schoolName = ?", [schoolName]);
    const claim = await queryOne("SELECT id FROM school_claims WHERE schoolName = ? AND status = 'approved' ORDER BY reviewedAt DESC LIMIT 1", [schoolName]);
    if (claim) { await run("UPDATE school_claims SET status = 'rejected', reviewedAt = ?, reviewedBy = ?, adminNotes = 'Verification revoked by admin' WHERE id = ?", [new Date().toISOString(), req.user.id, claim.id]); }
    res.json({ success: true });
});

app.get("/api/school-verified/:schoolName", async (req, res) => {
    const schoolName = decodeURIComponent(req.params.schoolName);
    const verified = await queryOne("SELECT * FROM verified_schools WHERE schoolName = ?", [schoolName]);
    res.json({ verified: !!verified });
});

// ========== SCHOOL SIGN-UP ROUTES ==========

app.get("/for-schools", (req, res) => {
    res.render("school-signup", { title: "For Schools - School Sentiment", currentPage: "for-schools" });
});

app.post("/submit-school-signup", schoolSignupLimiter, async (req, res) => {
    const { fullName, workEmail, workPhone, primaryWebsite, schoolName, roleAtSchool, numberOfSchools, numberOfCoworkers, howDidYouHear, authorised, termsAgreed } = req.body;
    if (!fullName || !workEmail || !schoolName || !roleAtSchool || !numberOfSchools || !numberOfCoworkers || !howDidYouHear) return res.redirect("/for-schools?error=Please fill in all required fields");
    if (!authorised || !termsAgreed) return res.redirect("/for-schools?error=You must agree to the terms");
    
    const existingClaim = await queryOne("SELECT * FROM school_claims WHERE claimantEmail = ? AND status IN ('pending', 'approved', 'rejected')", [workEmail]);
    if (existingClaim) {
        let statusMessage = '';
        if (existingClaim.status === 'pending') statusMessage = 'This email has a pending claim. Please wait for admin review.';
        else if (existingClaim.status === 'approved') statusMessage = 'This email already has an approved claim. Contact support if you believe this is an error.';
        else if (existingClaim.status === 'rejected') statusMessage = 'This email has a rejected claim. The claim must be deleted by admin before you can sign up again.';
        return res.redirect(`/for-schools?error=${encodeURIComponent(statusMessage)}`);
    }
    
    let user = await queryOne("SELECT * FROM users WHERE email = ?", [workEmail]);
    if (user) {
        if (user.isSchoolStaff === 1) { return res.redirect("/for-schools?error=This email is already registered as school staff. Please sign in."); }
        await run(
            `UPDATE users SET isSchoolStaff = 1, schoolRepresentative = ?, workPhone = ?, primaryWebsite = ?, numberOfSchools = ?, numberOfCoworkers = ?, howDidYouHear = ?, signupComplete = 1, fullName = ?, roleAtSchool = ? WHERE id = ?`,
            [schoolName, workPhone || null, primaryWebsite || null, numberOfSchools, numberOfCoworkers, howDidYouHear, fullName, roleAtSchool, user.id]
        );
    } else {
        const userId = crypto.randomUUID();
        const createdAt = new Date().toISOString();
        await run(
            `INSERT INTO users (id, email, createdAt, reviewIds, savedSchools, followedSchools, savedReviewIds, savedAdIds, banned, termsAgreedAt, isSchoolStaff, schoolRepresentative, workPhone, primaryWebsite, numberOfSchools, numberOfCoworkers, howDidYouHear, signupComplete, fullName, roleAtSchool) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [userId, workEmail, createdAt, '[]', '[]', '[]', '[]', '[]', 0, new Date().toISOString(), 1, schoolName, workPhone || null, primaryWebsite || null, numberOfSchools, numberOfCoworkers, howDidYouHear, 1, fullName, roleAtSchool]
        );
        user = await queryOne("SELECT * FROM users WHERE id = ?", [userId]);
    }
    
    const magicToken = crypto.randomBytes(32).toString("hex");
    await run("DELETE FROM magic_links WHERE userId = ?", [user.id]);
    await run(
        `INSERT INTO magic_links (token, userId, claimReviewId, expiresAt) VALUES (?, ?, ?, ?)`,
        [magicToken, user.id, null, new Date(Date.now() + 15 * 60 * 1000).toISOString()]
    );
    const magicLink = `${process.env.BASE_URL || "http://localhost:3000"}/verify-school-signup?token=${magicToken}`;
    try {
        await sendEmail(workEmail, 'Verify your School Staff Account', `<div><h2>🏫 Verify Your School Staff Account</h2><p>Hello ${fullName},</p><p>Click the button below to verify your work email:</p><a href="${magicLink}" style="background:#4f46e5;color:white;padding:12px 24px;text-decoration:none;border-radius:8px;">Verify Email →</a><p>This link expires in 15 minutes.</p></div>`);
        await sendEmail(process.env.ADMIN_EMAIL || "hubzy@hotmail.com", `🏫 New School Staff Sign-Up: ${schoolName}`, `<div><h2>New School Staff Sign-Up</h2><p><strong>School:</strong> ${schoolName}</p><p><strong>Name:</strong> ${fullName}</p><p><strong>Email:</strong> ${workEmail}</p><p><strong>Role:</strong> ${roleAtSchool}</p><p><strong>Number of schools:</strong> ${numberOfSchools}</p><p><strong>Coworkers:</strong> ${numberOfCoworkers}</p><p><strong>How heard:</strong> ${howDidYouHear}</p></div>`).catch(e => console.log("Admin email error:", e.message));
        res.render("school-signup-success", { title: "Verification Email Sent - School Sentiment", email: workEmail, currentPage: "for-schools" });
    } catch (error) {
        console.error('Email error:', error);
        res.redirect("/for-schools?error=Error sending verification email. Please try again.");
    }
});

app.get("/verify-school-signup", async (req, res) => {
    const token = req.query.token;
    const link = await queryOne("SELECT * FROM magic_links WHERE token = ? AND expiresAt > ?", [token, new Date().toISOString()]);
    if (!link) { return res.redirect("/for-schools?error=Invalid or expired link"); }
    await run("DELETE FROM magic_links WHERE token = ?", [token]);
    const sessionToken = await createSession(link.userId);
    const user = await queryOne("SELECT schoolRepresentative FROM users WHERE id = ?", [link.userId]);
    const schoolName = user ? user.schoolRepresentative : '';
    res.setHeader("Set-Cookie", `sessionToken=${sessionToken}; Path=/; Max-Age=2592000; HttpOnly`);
    if (schoolName) {
        res.redirect(`/school/${encodeURIComponent(schoolName)}?verified=1`);
    } else {
        res.redirect("/dashboard?message=School staff account verified! You can now claim your school.");
    }
});

app.get("/api/claim-details/:claimId", async (req, res) => {
    const { claimId } = req.params;
    const claim = await queryOne("SELECT * FROM school_claims WHERE id = ?", [claimId]);
    if (!claim) { return res.json({ success: false, error: "Claim not found" }); }
    const user = await queryOne("SELECT id, email, createdAt, schoolRepresentative, workPhone, primaryWebsite, numberOfSchools, numberOfCoworkers, howDidYouHear, roleAtSchool, fullName, isSchoolStaff FROM users WHERE id = ?", [claim.claimantUserId]);
    res.json({ success: true, claim, user });
});

app.post("/admin/delete-claim", async (req, res) => {
    if (!req.user || !req.user.isAdmin) return res.status(403).json({ error: "Unauthorized" });
    const { claimId } = req.body;
    const claim = await queryOne("SELECT claimantUserId, schoolName FROM school_claims WHERE id = ?", [claimId]);
    const result = await run("DELETE FROM school_claims WHERE id = ?", [claimId]);
    if (claim && claim.claimantUserId) {
        await run(
            `UPDATE users SET isSchoolStaff = 0, signupComplete = 0, schoolRepresentative = NULL, workPhone = NULL, primaryWebsite = NULL, numberOfSchools = NULL, numberOfCoworkers = NULL, howDidYouHear = NULL, roleAtSchool = NULL, fullName = NULL, workTitle = NULL WHERE id = ?`,
            [claim.claimantUserId]
        );
        console.log(`🔄 Reset school staff status for user ${claim.claimantUserId} from deleted claim for ${claim.schoolName}`);
    }
    if (result.affectedRows > 0) { res.json({ success: true }); } else { res.json({ success: false, error: "Claim not found" }); }
});

// ========== DELETE AD IMAGE API ==========

app.post("/api/delete-ad-image", async (req, res) => {
    if (!req.user) return res.status(401).json({ error: "Please sign in" });
    const { imageId, adId } = req.body;
    if (!imageId || !adId) return res.status(400).json({ error: "Missing imageId or adId" });
    const success = await deleteAdImage(imageId, adId, req.user.id);
    if (success) { res.json({ success: true }); }
    else { res.status(403).json({ error: "Not authorized or image not found" }); }
});

// ========== EDIT SCHOOL PROFILE ==========

app.get("/edit-school-profile/:schoolName", async (req, res) => {
    if (!req.user) return res.redirect('/signin');
    if (req.user.isSchoolStaff !== 1) return res.status(403).send("Access denied. Only school staff can edit school profiles.");
    
    const schoolName = decodeURIComponent(req.params.schoolName);
    const verified = await queryOne("SELECT * FROM verified_schools WHERE schoolName = ?", [schoolName]);
    if (!verified) { return res.status(403).send("Access denied. You must be verified for this school to edit its profile."); }
    
    const userSchool = await queryOne("SELECT schoolRepresentative FROM users WHERE id = ?", [req.user.id]);
    if (userSchool && userSchool.schoolRepresentative !== schoolName) { return res.status(403).send("Access denied. You can only edit the school you registered with."); }
    
    const user = await queryOne("SELECT workPhone, primaryWebsite, schoolDescription, contactEmail FROM users WHERE id = ?", [req.user.id]);
    res.render("edit-school-profile", {
        title: `Edit ${schoolName} - SchoolSentiment`,
        schoolName: schoolName,
        workPhone: user ? user.workPhone : '',
        primaryWebsite: user ? user.primaryWebsite : '',
        schoolDescription: user ? user.schoolDescription : '',
        contactEmail: user ? user.contactEmail : '',
        currentPage: "school"
    });
});

app.post("/update-school-profile", async (req, res) => {
    if (!req.user) return res.status(401).send("Please sign in");
    if (req.user.isSchoolStaff !== 1) return res.status(403).send("Access denied");
    
    const { schoolName, workPhone, primaryWebsite, schoolDescription, contactEmail } = req.body;
    
    const verified = await queryOne("SELECT * FROM verified_schools WHERE schoolName = ?", [schoolName]);
    if (!verified) { return res.status(403).send("Access denied. You must be verified for this school to edit its profile."); }
    
    const userSchool = await queryOne("SELECT schoolRepresentative FROM users WHERE id = ?", [req.user.id]);
    if (userSchool && userSchool.schoolRepresentative !== schoolName) { return res.status(403).send("Access denied. You can only edit the school you registered with."); }
    
    await run(
        `UPDATE users SET 
            workPhone = ?,
            primaryWebsite = ?,
            schoolDescription = ?,
            contactEmail = ?
        WHERE id = ?`,
        [workPhone || null, primaryWebsite || null, schoolDescription || null, contactEmail || null, req.user.id]
    );
    
    res.redirect(`/school/${encodeURIComponent(schoolName)}?profile_updated=1`);
});

// ========== ADMIN ANALYTICS API ==========

app.get("/api/admin/analytics", async (req, res) => {
    if (!req.user || !req.user.isAdmin) return res.status(403).json({ error: "Unauthorized" });
    
    const totalSchools = 42417;
    const schoolStaff = await queryOne("SELECT COUNT(*) as count FROM users WHERE isSchoolStaff = 1");
    const totalUsers = await queryOne("SELECT COUNT(*) as count FROM users");
    const totalReviews = await queryOne("SELECT COUNT(*) as count FROM reviews");
    const totalAds = await queryOne("SELECT COUNT(*) as count FROM ads WHERE status = 'active'");
    const pendingClaims = await queryOne("SELECT COUNT(*) as count FROM school_claims WHERE status = 'pending'");
    const approvedClaims = await queryOne("SELECT COUNT(*) as count FROM school_claims WHERE status = 'approved'");
    const rejectedClaims = await queryOne("SELECT COUNT(*) as count FROM school_claims WHERE status = 'rejected'");
    const verifiedSchools = await queryOne("SELECT COUNT(*) as count FROM verified_schools");
    const totalReplies = await queryOne("SELECT COUNT(*) as count FROM school_responses");
    const flaggedReviews = await queryOne("SELECT COUNT(*) as count FROM flagged_reviews WHERE status = 'pending' AND type = 'review'");
    const flaggedReplies = await queryOne("SELECT COUNT(*) as count FROM flagged_reviews WHERE status = 'pending' AND type = 'reply'");
    
    res.json({
        success: true,
        data: {
            totalSchools: totalSchools,
            schoolStaff: schoolStaff.count,
            totalUsers: totalUsers.count,
            totalReviews: totalReviews.count,
            totalAds: totalAds.count,
            claims: {
                pending: pendingClaims.count,
                approved: approvedClaims.count,
                rejected: rejectedClaims.count
            },
            verifiedSchools: verifiedSchools.count,
            totalReplies: totalReplies.count,
            flagged: {
                reviews: flaggedReviews.count,
                replies: flaggedReplies.count
            }
        }
    });
});

// ========== CONTACT FORM SUBMISSION ==========

app.post("/contact/submit", contactLimiter, async (req, res) => {
    const { name, email, subject, message } = req.body;
    
    if (!name || !email || !subject || !message) {
        return res.render("contact", { 
            title: "Contact Us - SchoolSentiment", 
            currentPage: "contact",
            errorMessage: "Please fill in all fields"
        });
    }
    
    if (!email.includes('@') || !email.includes('.')) {
        return res.render("contact", { 
            title: "Contact Us - SchoolSentiment", 
            currentPage: "contact",
            errorMessage: "Please enter a valid email address"
        });
    }
    
    try {
        const adminEmail = process.env.ADMIN_EMAIL || "hubzy@hotmail.com";
        
        const emailHtml = `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e2e8f0; border-radius: 12px;">
                <h2 style="color: #4f46e5;">📬 New Contact Form Message</h2>
                <table style="width: 100%; margin: 20px 0; border-collapse: collapse;">
                    <tr style="border-bottom: 1px solid #e2e8f0;">
                        <td style="padding: 8px 0; font-weight: bold; width: 100px;">Name:</td>
                        <td style="padding: 8px 0;">${sanitizeInput(name)}</td>
                    </tr>
                    <tr style="border-bottom: 1px solid #e2e8f0;">
                        <td style="padding: 8px 0; font-weight: bold;">Email:</td>
                        <td style="padding: 8px 0;">${sanitizeInput(email)}</td>
                    </tr>
                    <tr style="border-bottom: 1px solid #e2e8f0;">
                        <td style="padding: 8px 0; font-weight: bold;">Subject:</td>
                        <td style="padding: 8px 0;">${sanitizeInput(subject)}</td>
                    </tr>
                    <tr style="border-bottom: 1px solid #e2e8f0;">
                        <td style="padding: 8px 0; font-weight: bold; vertical-align: top;">Message:</td>
                        <td style="padding: 8px 0;">${sanitizeInput(message).replace(/\n/g, '<br>')}</td>
                    </tr>
                </table>
                <p style="font-size: 12px; color: #94a3b8; margin-top: 20px;">Sent from SchoolSentiment contact form</p>
            </div>
        `;
        
        await sendEmail(adminEmail, `📧 Contact Form: ${subject} from ${name}`, emailHtml);
        
        const autoReplyHtml = `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e2e8f0; border-radius: 12px;">
                <h2 style="color: #4f46e5;">Thank you for contacting SchoolSentiment</h2>
                <p>Hello ${sanitizeInput(name)},</p>
                <p>We have received your message and will get back to you within 48 hours.</p>
                <p><strong>Your message summary:</strong></p>
                <div style="background: #f8f9fa; padding: 15px; border-radius: 8px; margin: 15px 0;">
                    <p style="margin: 0 0 5px 0;"><strong>Subject:</strong> ${sanitizeInput(subject)}</p>
                    <p style="margin: 0;"><strong>Message:</strong> "${sanitizeInput(message).substring(0, 200)}${sanitizeInput(message).length > 200 ? '...' : ''}"</p>
                </div>
                <p>Best regards,<br>The SchoolSentiment Team</p>
                <hr style="margin: 20px 0;">
                <p style="font-size: 11px; color: #94a3b8;">SchoolSentiment - Honest school reviews from real parents, students, and staff</p>
            </div>
        `;
        
        await sendEmail(email, "Thank you for contacting SchoolSentiment", autoReplyHtml);
        
        res.render("contact", { 
            title: "Contact Us - SchoolSentiment", 
            currentPage: "contact",
            successMessage: "✅ Your message has been sent! We'll reply within 48 hours."
        });
        
    } catch (error) {
        console.error("Contact form error:", error);
        res.render("contact", { 
            title: "Contact Us - SchoolSentiment", 
            currentPage: "contact",
            errorMessage: "Sorry, there was an error sending your message. Please try again later or email us directly at hello@schoolsentiment.co.uk"
        });
    }
});

// ========== FLAG AD API ==========
app.post("/api/flag-ad/:adId", async (req, res) => {
    if (!req.user) {
        return res.status(401).json({ error: "Please sign in to flag ads" });
    }
    
    const adId = req.params.adId;
    const { reason, details } = req.body;
    
    if (!reason) {
        return res.status(400).json({ error: "Please select a reason" });
    }
    
    const existingFlag = await queryOne("SELECT * FROM flagged_ads WHERE adId = ? AND flaggedBy = ? AND status = 'pending'", [adId, req.user.id]);
    if (existingFlag) { return res.status(400).json({ error: "You have already flagged this ad" }); }
    
    const ad = await getAdById(adId);
    await run(
        `INSERT INTO flagged_ads (adId, reason, details, flaggedBy, flaggedAt, status) VALUES (?, ?, ?, ?, ?, 'pending')`,
        [adId, reason, details || null, req.user.id, new Date().toISOString()]
    );
    
    const adminEmail = process.env.ADMIN_EMAIL || "hubzy@hotmail.com";
    const reasonMap = {
        'spam': 'Spam or advertising',
        'inappropriate': 'Inappropriate content',
        'scam': 'Scam or misleading',
        'prohibited': 'Prohibited item (alcohol, weapons, etc.)',
        'other': 'Other'
    };
    
    try {
        await sendEmail(adminEmail, `🚩 Ad Flagged for Review`, `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e2e8f0; border-radius: 12px;">
                <h2 style="color: #dc2626;">🚩 Ad Flagged for Review</h2>
                <p><strong>Ad ID:</strong> ${adId}</p>
                <p><strong>Ad Title:</strong> ${ad ? ad.title : 'Unknown'}</p>
                <p><strong>School:</strong> ${ad ? ad.schoolName : 'Unknown'}</p>
                <p><strong>Flagged by:</strong> ${req.user.email}</p>
                <p><strong>Reason:</strong> ${reasonMap[reason] || reason}</p>
                ${details ? `<p><strong>Details:</strong> ${details}</p>` : ''}
                <p><strong>Time:</strong> ${new Date().toLocaleString()}</p>
                <hr style="margin: 20px 0;">
                <p><a href="http://localhost:3000/admin/flagged-ads" style="display: inline-block; background: #dc2626; color: white; padding: 10px 20px; text-decoration: none; border-radius: 8px;">Review Flagged Ads →</a></p>
            </div>
        `);
    } catch(e) {
        console.error("Failed to send admin email:", e.message);
    }
    
    res.json({ success: true, message: "Ad flagged for review. Thank you for helping keep our community safe." });
});

// ========== ADMIN FLAGGED ADS ==========

app.get("/api/admin/flagged-ads", async (req, res) => {
    if (!req.user || !req.user.isAdmin) return res.status(403).json({ error: "Unauthorized" });
    const flagged = await query("SELECT * FROM flagged_ads WHERE status = 'pending' ORDER BY flaggedAt DESC");
    res.json({ flagged });
});

app.get("/api/admin/flagged-ads-count", async (req, res) => {
    const result = await queryOne("SELECT COUNT(*) as count FROM flagged_ads WHERE status = 'pending'");
    res.json({ count: result.count });
});

app.get("/admin/flagged-ads", (req, res) => {
    if (!req.user || !req.user.isAdmin) return res.status(403).send("Admin access required");
    res.render("admin-flagged-ads", { title: "Flagged Ads - SchoolSentiment", currentPage: "admin" });
});

app.post("/api/resolve-ad-flag", async (req, res) => {
    if (!req.user || !req.user.isAdmin) return res.status(403).json({ error: "Unauthorized" });
    const { flagId } = req.body;
    await run("UPDATE flagged_ads SET status = 'resolved' WHERE id = ?", [flagId]);
    res.json({ success: true });
});

app.post("/api/hide-ad", async (req, res) => {
    if (!req.user || !req.user.isAdmin) return res.status(403).json({ error: "Unauthorized" });
    const { adId, flagId } = req.body;
    await run("UPDATE ads SET status = 'hidden' WHERE id = ?", [adId]);
    await run("UPDATE flagged_ads SET status = 'resolved' WHERE id = ?", [flagId]);
    res.json({ success: true });
});

app.get("/api/ad/:adId", async (req, res) => {
    const ad = await getAdById(req.params.adId);
    if (ad) {
        res.json(ad);
    } else {
        res.json({ title: "Unknown", schoolName: "Unknown" });
    }
});

app.post("/api/admin/delete-ad", async (req, res) => {
    if (!req.user || !req.user.isAdmin) return res.status(403).json({ error: "Unauthorized" });
    const { adId, flagId } = req.body;
    await run("DELETE FROM ads WHERE id = ?", [adId]);
    if (flagId) {
        await run("UPDATE flagged_ads SET status = 'resolved' WHERE id = ?", [flagId]);
    }
    res.json({ success: true });
});

// ========== FLAGGED REPLIES API ==========
app.get("/api/flagged-replies", async (req, res) => {
    const flagged = await query("SELECT * FROM flagged_reviews WHERE status = 'pending' AND type = 'reply' ORDER BY flaggedAt DESC");
    res.json({ flagged: flagged });
});

// ========== MARK AD AS SOLD ==========
app.post("/api/mark-ad-sold/:adId", async (req, res) => {
    if (!req.user) return res.status(401).json({ error: "Please sign in" });
    const adId = req.params.adId;
    const ad = await getAdById(adId);
    if (!ad) { return res.status(404).json({ error: "Ad not found" }); }
    if (ad.userId !== req.user.id) { return res.status(403).json({ error: "You don't own this ad" }); }
    if (ad.status === 'sold') { return res.status(400).json({ error: "Ad is already marked as sold" }); }
    await run("UPDATE ads SET status = 'sold', soldAt = NOW() WHERE id = ?", [adId]);
    res.json({ success: true, message: "Ad marked as sold" });
});

// ========== MARK AD AS AVAILABLE ==========
app.post("/api/mark-ad-available/:adId", async (req, res) => {
    if (!req.user) return res.status(401).json({ error: "Please sign in" });
    const adId = req.params.adId;
    const ad = await getAdById(adId);
    if (!ad) { return res.status(404).json({ error: "Ad not found" }); }
    if (ad.userId !== req.user.id) { return res.status(403).json({ error: "You don't own this ad" }); }
    if (ad.status !== 'sold') { return res.status(400).json({ error: "Ad is not marked as sold" }); }
    await run("UPDATE ads SET status = 'active', soldAt = NULL WHERE id = ?", [adId]);
    res.json({ success: true, message: "Ad marked as available" });
});

// ========== TOGGLE AD VISIBILITY (Admin) ==========
app.post("/api/toggle-ad-visibility", async (req, res) => {
    if (!req.user || !req.user.isAdmin) return res.status(403).json({ error: "Unauthorized" });
    const { adId, flagId, action } = req.body;
    if (!adId || !action) { return res.status(400).json({ error: "Missing adId or action" }); }
    const ad = await getAdById(adId);
    if (!ad) { return res.status(404).json({ error: "Ad not found" }); }
    if (action === 'hide') {
        await run("UPDATE ads SET status = 'hidden' WHERE id = ?", [adId]);
        // Keep flag as pending - do NOT resolve it
    } else if (action === 'unhide') {
        await run("UPDATE ads SET status = 'active' WHERE id = ?", [adId]);
        // Keep flag as pending - do NOT resolve it
    } else {
        return res.status(400).json({ error: "Invalid action. Use 'hide' or 'unhide'" });
    }
    res.json({ success: true });
});

app.listen(PORT, () => {
    console.log("✅ Server running at http://localhost:3000");
    console.log(`📚 Loaded ${schoolsData.length} UK schools`);
    console.log("🔐 Authentication system ready - magic link login enabled");
});
