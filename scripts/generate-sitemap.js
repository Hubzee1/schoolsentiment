const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const db = new Database(path.join(__dirname, '..', 'database.sqlite'));
const schools = db.prepare("SELECT name FROM schools ORDER BY name").all();
db.close();

const baseUrl = 'http://localhost:3000';
const now = new Date().toISOString();

let sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${baseUrl}/</loc>
    <lastmod>${now}</lastmod>
    <priority>1.0</priority>
  </url>
  <url>
    <loc>${baseUrl}/noticeboard</loc>
    <lastmod>${now}</lastmod>
    <priority>0.8</priority>
  </url>
  <url>
    <loc>${baseUrl}/review</loc>
    <lastmod>${now}</lastmod>
    <priority>0.8</priority>
  </url>
  <url>
    <loc>${baseUrl}/blog</loc>
    <lastmod>${now}</lastmod>
    <priority>0.6</priority>
  </url>`;

for (const school of schools) {
  sitemap += `
  <url>
    <loc>${baseUrl}/school/${encodeURIComponent(school.name)}</loc>
    <lastmod>${now}</lastmod>
    <priority>0.7</priority>
  </url>
  <url>
    <loc>${baseUrl}/school/${encodeURIComponent(school.name)}/noticeboard</loc>
    <lastmod>${now}</lastmod>
    <priority>0.6</priority>
  </url>`;
}

sitemap += `
</urlset>`;

fs.writeFileSync(path.join(__dirname, '..', 'public', 'sitemap.xml'), sitemap);
console.log(`✅ Sitemap generated with ${schools.length} schools (${schools.length * 2 + 4} total URLs)`);
