const fs = require('fs');
const path = require('path');

// Load schools from the JSON file
const schoolsDataPath = path.join(__dirname, '..', 'models', 'uk-schools.json');
const schoolsData = JSON.parse(fs.readFileSync(schoolsDataPath, 'utf8'));

const baseUrl = 'https://schoolsentiment.co.uk';
const now = new Date().toISOString().split('T')[0];

// Split schools into chunks of 50,000
const chunkSize = 50000;
const schoolChunks = [];
for (let i = 0; i < schoolsData.length; i += chunkSize) {
    schoolChunks.push(schoolsData.slice(i, i + chunkSize));
}

// Generate main pages sitemap
function generatePagesSitemap() {
    const pages = [
        { loc: '/', priority: '1.0' },
        { loc: '/noticeboard', priority: '0.8' },
        { loc: '/review', priority: '0.8' },
        { loc: '/blog', priority: '0.6' },
        { loc: '/for-schools', priority: '0.6' },
        { loc: '/contact', priority: '0.5' },
        { loc: '/saved-reviews', priority: '0.5' },
        { loc: '/messages', priority: '0.5' },
        { loc: '/account', priority: '0.5' }
    ];

    let xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">`;

    pages.forEach(page => {
        xml += `
  <url>
    <loc>${baseUrl}${page.loc}</loc>
    <lastmod>${now}</lastmod>
    <priority>${page.priority}</priority>
  </url>`;
    });

    xml += `
</urlset>`;

    const filePath = path.join(__dirname, '..', 'public', 'sitemap-pages.xml');
    fs.writeFileSync(filePath, xml);
    console.log('✅ Generated: sitemap-pages.xml');
}

// Generate school sitemaps (chunked)
function generateSchoolSitemaps() {
    schoolChunks.forEach((chunk, index) => {
        const chunkNum = index + 1;
        let xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">`;

        // Add each school in this chunk
        chunk.forEach(school => {
            const encodedName = encodeURIComponent(school.name);
            // School profile
            xml += `
  <url>
    <loc>${baseUrl}/school/${encodedName}</loc>
    <lastmod>${now}</lastmod>
    <priority>0.7</priority>
  </url>`;
            // School noticeboard
            xml += `
  <url>
    <loc>${baseUrl}/school/${encodedName}/noticeboard</loc>
    <lastmod>${now}</lastmod>
    <priority>0.6</priority>
  </url>`;
        });

        xml += `
</urlset>`;

        const filePath = path.join(__dirname, '..', 'public', `sitemap-schools-${chunkNum}.xml`);
        fs.writeFileSync(filePath, xml);
        console.log(`✅ Generated: sitemap-schools-${chunkNum}.xml (${chunk.length} schools, ${chunk.length * 2} URLs)`);
    });
}

// Generate master sitemap index
function generateSitemapIndex() {
    let xml = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap>
    <loc>${baseUrl}/sitemap-pages.xml</loc>
    <lastmod>${now}</lastmod>
  </sitemap>`;

    schoolChunks.forEach((chunk, index) => {
        const chunkNum = index + 1;
        xml += `
  <sitemap>
    <loc>${baseUrl}/sitemap-schools-${chunkNum}.xml</loc>
    <lastmod>${now}</lastmod>
  </sitemap>`;
    });

    xml += `
</sitemapindex>`;

    const filePath = path.join(__dirname, '..', 'public', 'sitemap-index.xml');
    fs.writeFileSync(filePath, xml);
    console.log('✅ Generated: sitemap-index.xml');
}

// Run all
console.log('📸 Generating sitemaps...');
generatePagesSitemap();
generateSchoolSitemaps();
generateSitemapIndex();
console.log('✅ All sitemaps generated successfully!');
console.log(`   📍 Total schools: ${schoolsData.length}`);
console.log(`   📄 Total sitemaps: ${schoolChunks.length + 1}`);
console.log(`   🗂️ Submit: sitemap-index.xml`);
