/**
 * CategoryGrouper - Groups specific labels into broad categories.
 * Optimized with word boundary checks to avoid "hotdog" -> "dog".
 */

export function getCategoryGroup(englishLabel: string): string | null {
    const lower = englishLabel.toLowerCase();

    // Helper to check for whole word match
    const hasWord = (word: string) => {
        const regex = new RegExp(`\\b${word}\\b`, 'i');
        return regex.test(lower);
    };

    // --- CATS ---
    if (
        hasWord('cat') ||
        hasWord('tabby') ||
        hasWord('siamese') ||
        hasWord('kitty') ||
        hasWord('kitten')
    ) {
        // Exclude wild cats explicitly if they are distinct words (though 'cat' might appear in 'wild cat')
        // ImageNet classes: 'tiger', 'lion' don't have 'cat' in name usually.
        // 'tiger cat' IS a domestic cat.
        return 'cat';
    }

    // --- DOGS ---
    // Comprehensive list of dog-related keywords in ImageNet
    const dogKeywords = [
        'dog', 'terrier', 'spaniel', 'retriever', 'shepherd', 'hound', 'setter',
        'collie', 'mastiff', 'schnauzer', 'poodle', 'corgi', 'bulldog', 'pug',
        'beagle', 'husky', 'malamute', 'dalmatian', 'chihuahua', 'pinscher',
        'dane', 'spitz', 'keeshond', 'chow', 'samoyed', 'pekinese', 'shih-tzu',
        'papillon', 'whippet', 'rottweiler', 'boxer', 'pomeranian', 'labrador',
        'dachshund', 'sheepdog', 'bull', 'griffon', 'pointer', 'weimaraner',
        'vizsla', 'bernard', 'newfoundland', 'pyrenees', 'leonberg', 'basenji',
        'affenpinscher', 'maltese', 'lhasa', 'hairless', 'ridgeback', 'saluki',
        'wolfhound', 'deerhound', 'elkhound', 'komondor', 'kuvasz', 'schipperke',
        'groenendael', 'malinois', 'briard', 'kelpie', 'shiba', 'akita'
    ];

    // Special case: "cardigan" alone usually means "Cardigan Welsh Corgi" in ImageNet
    // (The clothing "cardigan" would appear in different contexts)
    if (lower === 'cardigan') {
        return 'dog';
    }

    if (dogKeywords.some(keyword => hasWord(keyword))) {
        // Exclude 'hotdog' (handled by \b boundary, hotdog is one word)
        // 'prairie dog' -> is a rodent.
        if (hasWord('prairie') && hasWord('dog')) return null; // Keep 'prairie dog'
        return 'dog';
    }

    // --- BIRDS ---
    if (
        hasWord('bird') || hasWord('eagle') || hasWord('owl') ||
        hasWord('penguin') || hasWord('parrot') || hasWord('sparrow') ||
        hasWord('robin') || hasWord('finch') || hasWord('hawk')
    ) {
        return 'bird';
    }

    // --- SCREENSHOTS / UI ---
    const screenshotKeywords = [
        'crossword puzzle', 'web site', 'menu', 'monitor', 'screen', 'comic book'
    ];
    if (screenshotKeywords.some(keyword => hasWord(keyword))) {
        return 'screenshot';
    }

    // --- HUMAN / CLOTHING (Implies Person) ---
    const humanKeywords = [
        'groom', 'ballplayer', 'scuba diver', 'bikini', 'maillot', 'swimming trunks',
        'uniform', 'academic gown', 'suit', 'trench coat', 'jersey', 'pajama', 'kimono',
        'miniskirt', 'sarong', 'lab coat', 'cowboy hat', 'sunscreen', 'perfume'
    ];
    // Note: perfume/sunscreen might be objects, but often imply people context. 
    // Let's stick to clothing/roles. Removed perfume/sunscreen/cowboy hat (could be just hat).
    const strongHumanKeywords = [
        'groom', 'ballplayer', 'scuba diver', 'bikini', 'maillot', 'swimming trunks',
        'uniform', 'academic gown', 'trench coat', 'kimono', 'miniskirt', 'sarong', 'lab coat',
        'sweatshirt', 'poncho', 'apron', 'cloak', 'vestment', 'bow tie', 'cardigan',
        'cellular telephone', 'hand-held computer' // Mirror selfies often detected as phone
    ];

    if (strongHumanKeywords.some(keyword => hasWord(keyword))) {
        return 'people';
    }

    return null;
}
