const fs = require('fs');
const schools = require('../models/uk-schools.json');

const grouped = {};
schools.forEach(school => {
  const name = school.name;
  if (!grouped[name]) grouped[name] = [];
  grouped[name].push(school);
});

const deduped = [];
Object.keys(grouped).forEach(name => {
  const records = grouped[name];
  if (records.length === 1) {
    deduped.push(records[0]);
  } else {
    const scored = records.map(record => {
      let score = 0;
      if (record.website && record.website !== '') score += 10;
      if (record.address && record.address !== '') score += 5;
      if (record.phase && record.phase !== '') score += 3;
      if (record.type && record.type !== '') score += 2;
      if (record.postcode && record.postcode !== '') score += 1;
      return { record, score };
    });
    scored.sort((a, b) => b.score - a.score);
    deduped.push(scored[0].record);
  }
});

console.log('Original:', schools.length);
console.log('Deduplicated:', deduped.length);
console.log('Removed:', schools.length - deduped.length);

fs.writeFileSync('models/uk-schools-deduped.json', JSON.stringify(deduped, null, 2));
console.log('✅ Saved to models/uk-schools-deduped.json');
