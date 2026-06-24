const axios = require('axios');
require('dotenv').config();

async function sendEmail(to, subject, htmlContent) {
    try {
        const apiKey = process.env.BREVO_API_KEY;
        
        console.log(`📧 Sending email to ${to}...`);
        
        if (!apiKey) {
            console.log("❌ No API key found");
            return { success: false };
        }
        
        const response = await axios({
            method: 'post',
            url: 'https://api.brevo.com/v3/smtp/email',
            headers: {
                'api-key': apiKey,
                'Content-Type': 'application/json'
            },
            data: {
                sender: { email: 'noreply@schoolsentiment.co.uk', name: 'School Sentiment' },
                to: [{ email: to }],
                subject: subject,
                htmlContent: htmlContent
            }
        });
        
        console.log(`✅ Email sent to ${to}`);
        return { success: true };
    } catch (error) {
        console.error(`❌ Email error for ${to}:`, error.response?.data?.message || error.message);
        return { success: false, error: error.message };
    }
}

module.exports = { sendEmail };
