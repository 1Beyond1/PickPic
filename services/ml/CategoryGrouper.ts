import { IMAGENET_LABELS } from './ImageNetLabels';

// Display categories are derived from raw labels; never rewrite labels_json.
// Enumerate known classes instead of matching words such as "car" or "dog".
export const ALBUM_CATEGORIES = {
    people: { zh: '人物', en: 'People' },
    dog: { zh: '狗', en: 'Dogs' },
    cat: { zh: '猫', en: 'Cats' },
    bird: { zh: '鸟', en: 'Birds' },
    animal: { zh: '其他动物', en: 'Other animals' },
    car: { zh: '汽车', en: 'Cars' },
    transport: { zh: '其他交通工具', en: 'Other transport' },
    food: { zh: '食物与饮品', en: 'Food & drinks' },
    landscape: { zh: '自然风景', en: 'Nature' },
    plant: { zh: '花草', en: 'Plants' },
    documents: { zh: '图文资料', en: 'Text & graphics' },
    electronics: { zh: '电子设备', en: 'Electronics' },
    clothing: { zh: '服饰', en: 'Clothing' },
    architecture: { zh: '建筑', en: 'Buildings' },
} as const;
export type AlbumCategory = keyof typeof ALBUM_CATEGORIES;

const groups = new Map<string, AlbumCategory>();
function add(category: AlbumCategory, names: readonly string[]) {
    for (const name of names) groups.set(name.toLowerCase(), category);
}
function range(first: string, last: string): string[] {
    const start = IMAGENET_LABELS.indexOf(first);
    const end = IMAGENET_LABELS.indexOf(last);
    if (start < 0 || end < start) throw new Error('Invalid bundled label taxonomy');
    return IMAGENET_LABELS.slice(start, end + 1);
}
add('animal', [...range('tench', 'puffer'), 'prairie dog']);
add('bird', [...range('cock', 'great grey owl'), ...range('black grouse', 'black swan'),
    ...range('white stork', 'albatross'), 'bird']);
add('dog', [...range('chihuahua', 'mexican hairless'), 'dog', 'cardigan welsh corgi']);
add('cat', [...range('tabby', 'egyptian cat'), 'cat', 'tabby cat', 'siamese', 'kitty', 'kitten']);
add('car', ['beach wagon', 'cab', 'convertible', 'jeep', 'limousine', 'minivan', 'model t',
    'racer', 'race car', 'racing car', 'sports car', 'sport car', 'car']);
add('transport', ['ambulance', 'bicycle-built-for-two', 'bullet train', 'container ship',
    'fire engine', 'garbage truck', 'minibus', 'moving van', 'pickup', 'police van',
    'school bus', 'trolleybus', 'trailer truck', 'tow truck', 'moped', 'motor scooter',
    'mountain bike', 'airliner', 'warplane', 'liner', 'canoe', 'catamaran', 'schooner',
    'speedboat', 'steam locomotive', 'electric locomotive', 'submarine', 'trimaran', 'yawl']);
add('food', [...range('guacamole', 'pomegranate'), ...range('carbonara', 'espresso'),
    'eggnog', 'hot dog']);
add('landscape', ['alp', 'cliff', 'coral reef', 'geyser', 'lakeside', 'promontory',
    'sandbar', 'seashore', 'valley', 'volcano', 'mountain']);
add('plant', ['rapeseed', 'daisy', 'yellow ladys slipper', 'acorn', 'buckeye']);
add('documents', ['web site', 'website', 'screenshot', 'crossword puzzle', 'menu',
    'comic book', 'book jacket']);
add('people', ['groom', 'ballplayer', 'scuba diver']);
add('electronics', ['cellular telephone', 'hand-held computer', 'desktop computer',
    'laptop', 'notebook', 'monitor', 'screen', 'computer keyboard', 'mouse', 'ipod',
    'remote control', 'modem', 'hard disc', 'printer', 'television', 'cassette player', 'cd player']);
add('clothing', ['bikini', 'lab coat', 'miniskirt', 'apron', 'bonnet', 'bow tie',
    'brassiere', 'cloak', 'cowboy boot', 'cowboy hat', 'fur coat', 'gown', 'jean',
    'jersey', 'kimono', 'military uniform', 'mitten', 'poncho', 'running shoe', 'sandal',
    'sarong', 'suit', 'sweatshirt', 'swimming trunks', 'trench coat', 'vestment', 'windsor tie']);
add('architecture', ['barn', 'boathouse', 'castle', 'church', 'dome', 'library',
    'monastery', 'mosque', 'palace', 'patio', 'prison', 'stupa', 'viaduct', 'water tower']);

// These texts name different ImageNet classes. Old results omit the index;
// preserve them as unknown rather than guessing which class was intended.
const ambiguous = new Set(['cardigan', 'crane', 'kite', 'maillot']);
export function getCategoryGroup(englishLabel: string): AlbumCategory | null {
    const primary = englishLabel.toLowerCase().trim().split(',')[0].trim();
    if (ambiguous.has(primary)) return null;
    return groups.get(primary) ?? null;
}
export function categoryTitle(category: AlbumCategory, language: 'zh' | 'en'): string {
    return ALBUM_CATEGORIES[category][language];
}
