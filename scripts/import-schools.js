const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');

const inputFile = path.join(__dirname, '..', 'models', 'gias-schools.csv');
const outputFile = path.join(__dirname, '..', 'models', 'uk-schools-full.json');

const schools = [];
let count = 0;
let errorCount = 0;

console.log('📚 Reading GIAS schools data...');

fs.createReadStream(inputFile)
  .pipe(csv())
  .on('data', (row) => {
    if (row.EstablishmentStatus && row.EstablishmentStatus !== 'Open') {
      return;
    }
    if (!row.EstablishmentName) {
      errorCount++;
      return;
    }
    const school = {
      id: parseInt(row.URN) || Date.now() + count,
      name: row.EstablishmentName || '',
      type: row.TypeOfEstablishment || '',
      postcode: row.Postcode || '',
      town: row.Town || '',
      county: row.AdministrativeCounty || '',
      website: row.SchoolWebsite || '',
      phase: row.PhaseOfEducation || '',
      address: row.Street || ''
    };
    schools.push(school);
    count++;
    if (count % 5000 === 0) {
      console.log(`   Processed ${count} schools...`);
    }
  })
  .on('end', () => {
    console.log(`\n✅ Imported ${count} schools`);
    console.log(`⚠️ Skipped ${errorCount} invalid rows`);
    fs.writeFileSync(outputFile, JSON.stringify(schools, null, 2));
    console.log(`💾 Saved to ${outputFile}`);
    const stats = fs.statSync(outputFile);
    console.log(`📊 File size: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
  })
  .on('error', (err) => {
    console.error('❌ Error reading CSV:', err.message);
  });
