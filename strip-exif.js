const fs = require('fs');
const sharp = require('sharp');

async function stripExifFromFile(filePath) {
    try {
        console.log('📸 EXIF STRIP: Starting for', filePath);
        
        if (!fs.existsSync(filePath)) {
            console.log('❌ File not found:', filePath);
            return false;
        }
        
        // Read the image metadata first to get dimensions
        const metadata = await sharp(filePath).metadata();
        
        // Create a temporary file path
        const tempPath = filePath + '.tmp';
        
        // Process the image with sharp - this strips all metadata by default
        let pipeline = sharp(filePath);
        
        // Optionally resize if too large (max 1200px)
        if (metadata.width > 1200 || metadata.height > 1200) {
            pipeline = pipeline.resize(1200, 1200, { 
                fit: 'inside', 
                withoutEnlargement: true 
            });
        }
        
        // Save to temp file with no metadata
        await pipeline
            .toFile(tempPath);
        
        // Replace the original file with the cleaned one
        fs.renameSync(tempPath, filePath);
        
        console.log('✅ EXIF stripped from:', filePath);
        return true;
        
    } catch (error) {
        console.error('❌ EXIF stripping error:', error.message);
        return false;
    }
}

module.exports = { stripExifFromFile };
