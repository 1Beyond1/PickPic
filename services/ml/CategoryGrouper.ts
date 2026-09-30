/**
 * CategoryGrouper - Groups specific labels into broad categories.
 * Optimized with word boundary checks to avoid "hotdog" -> "dog".
 */

export function getCategoryGroup(englishLabel: string): string | null {
    const lower = englishLabel.toLowerCase().trim();
    const primaryLabel = lower.split(',')[0].trim();
    // ImageNet includes both a corgi breed and a garment named "cardigan".
    // Text alone cannot distinguish those classes. Madagascar cat is a lemur.
    if (primaryLabel === 'cardigan' || primaryLabel === 'madagascar cat') return null;
    if (primaryLabel === 'hotdog' || primaryLabel === 'hot dog' || primaryLabel === 'prairie dog') return null;

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
        'dachshund', 'sheepdog', 'griffon', 'pointer', 'weimaraner',
        'vizsla', 'bernard', 'newfoundland', 'pyrenees', 'leonberg', 'basenji',
        'affenpinscher', 'maltese', 'lhasa', 'hairless', 'ridgeback', 'saluki',
        'wolfhound', 'deerhound', 'elkhound', 'komondor', 'kuvasz', 'schipperke',
        'groenendael', 'malinois', 'briard', 'kelpie', 'shiba', 'akita'
    ];

    // This breed's name contains "bull", but the standalone class "bull"
    // denotes a bovine, not a dog.
    if (primaryLabel === 'boston bull') {
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
        'crossword puzzle', 'web site', 'website', 'screenshot', 'menu', 'comic book'
    ];
    if (screenshotKeywords.some(keyword => hasWord(keyword))) {
        return 'screenshot';
    }

    // A garment or phone may be photographed on its own. Only human-role
    // labels are evidence of a person; the scanner separately detects faces.
    const strongHumanKeywords = [
        'groom', 'ballplayer', 'scuba diver',
    ];

    if (strongHumanKeywords.some(keyword => hasWord(keyword))) {
        return 'people';
    }

    return null;
}
