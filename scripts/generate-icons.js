const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const sizes = [72, 96, 128, 144, 152, 192, 384, 512];
const inputFile = path.join(__dirname, '..', 'public', 'images', 'SS_WPA_icon.png');
const outputDir = path.join(__dirname, '..', 'public', 'images');

if (!fs.existsSync(inputFile)) {
    console.error('❌ Input file not found:', inputFile);
    process.exit(1);
}

console.log('📸 Generating icons from:', inputFile);

async function generateIcons() {
    for (const size of sizes) {
        const outputFile = path.join(outputDir, `icon-${size}x${size}.png`);
        try {
            await sharp(inputFile)
                .resize(size, size, {
                    fit: 'cover',
                    position: 'centre'
                })
                .png()
                .toFile(outputFile);
            console.log(`✅ Generated: icon-${size}x${size}.png`);
        } catch (err) {
            console.error(`❌ Failed to generate ${size}x${size}:`, err.message);
        }
    }
    console.log('✅ All icons generated successfully!');
}

generateIcons();
