const fs = require('fs');
let server = fs.readFileSync('server.js', 'utf8');

// Replace the schoolsData loading line
const oldLoad = /const schoolsData = JSON\.parse\(fs\.readFileSync\(path\.join\(__dirname, "models\/uk-schools\.json"\), "utf8"\)\);/;
const newLoad = `// Load schools from SQLite
const db = new (require('better-sqlite3'))(path.join(__dirname, 'database.sqlite'));
const schoolsData = db.prepare('SELECT * FROM schools ORDER BY name').all();`;

if (oldLoad.test(server)) {
  server = server.replace(oldLoad, newLoad);
  fs.writeFileSync('server.js', server);
  console.log('✅ Updated server.js to load schools from SQLite');
} else {
  console.log('⚠️ Could not find schoolsData loading line, trying alternative...');
  
  // Alternative pattern
  const altLoad = /const schoolsData = JSON\.parse\(fs\.readFileSync\(path\.join\(__dirname, "models\/uk-schools\.json"\), "utf8"\)\)/;
  if (altLoad.test(server)) {
    server = server.replace(altLoad, newLoad);
    fs.writeFileSync('server.js', server);
    console.log('✅ Updated server.js (alternative pattern)');
  } else {
    console.log('❌ Could not find schoolsData loading line');
  }
}
