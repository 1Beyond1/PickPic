const fs = require('fs');
const path = require('path');

const targetFile = path.join(__dirname, '../services/ml/ImageNetTranslations.ts');

try {
    const content = fs.readFileSync(targetFile, 'utf8');
    const lines = content.split('\n');
    const seenKeys = new Set();
    const newLines = [];
    let duplicates = 0;

    const keyRegex = /^\s*"(.+?)":/;

    for (const line of lines) {
        const match = line.match(keyRegex);
        if (match) {
            const key = match[1];
            if (seenKeys.has(key)) {
                console.log(`Duplicate found: ${key}`);
                // Comment out the duplicate
                newLines.push(`    // DUPLICATE: ${line.trim()}`);
                duplicates++;
            } else {
                seenKeys.add(key);
                newLines.push(line);
            }
        } else {
            newLines.push(line);
        }
    }

    if (duplicates > 0) {
        fs.writeFileSync(targetFile, newLines.join('\n'), 'utf8');
        console.log(`Fixed ${duplicates} duplicates.`);
    } else {
        console.log('No duplicates found.');
    }

} catch (e) {
    console.error('Error:', e);
}
