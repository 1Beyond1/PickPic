import { IMAGENET_TRANSLATIONS } from './ImageNetTranslations';

const LABEL_MAP_ZH: Record<string, string> = {
    ...IMAGENET_TRANSLATIONS,
    // Custom overrides or additions
    'cat': '猫',
    'dog': '狗',
    'bird': '鸟',
    'wild_animal': '野生动物',
    'tabby': '斑纹猫',
    'tabby cat': '斑纹猫',
    'tabby, tabby cat': '斑纹猫',
    'persian cat': '波斯猫',
    'siamese cat, siamese': '暹罗猫',
    'egyptian cat': '埃及猫',
    'tiger cat': '虎斑猫',
    'golden retriever': '金毛寻回犬',
    'border collie': '边境牧羊犬',
    'toy poodle': '玩具贵宾犬',
    'coyote, prairie wolf, brush wolf, canis latrans': '郊狼',
    // Electronics
    'remote control, remote': '遥控器',
    'ipod': '手机/电子设备',
    'cellular telephone, cellular phone, cellphone, cell, mobile phone': '手机',
    'hand-held computer, hand-held microcomputer': '手机',
    'web site, website, internet site, site': '网页截图',
    'pencil sharpener': '文具/卷笔刀',
    'computer keyboard, keypad': '键盘',
    'mouse, computer mouse': '鼠标',
    'laptop, laptop computer': '笔记本电脑',
    'monitor': '显示器',
    'screen, crt screen': '屏幕',
    'desk': '书桌',
    'coffee mug': '马克杯',
    'cup': '杯子',
    'water bottle': '水瓶',
    'chair': '椅子',
    'sofa, couch, lounge': '沙发',
    'bed': '床',
    'dining table, board': '餐桌',
    'restaurant, eating house, eating place, eatery': '餐厅',
    'menu': '菜单',
    'plate': '盘子',
    'book jacket, dust cover, dust jacket, dust wrapper': '书籍',
    'comic book': '漫画书',
    'jigsaw puzzle': '拼图',
    'traffic light, traffic signal, stoplight': '红绿灯',
    'street sign': '路牌',
    'car mirror': '后视镜',
    'sports car, sport car': '跑车',
    'racer, race car, racing car': '赛车',
    'minivan': '面包车',
    'bicycle-built-for-two, tandem bicycle, tandem': '双人自行车',
    'mountain bike, all-terrain bike, off-roader': '山地车',
    'liner, ocean liner': '邮轮',
    'container ship, containership, container vessel': '集装箱船',
    'seashore, coast, seacoast, sea-coast': '海岸',
    'lakeside, lakeshore': '湖畔',
    'sandbar, sand bar': '沙滩',
    'mountain, mount': '山脉',
    'alp': '高山',
    'volcano': '火山',
    'valley, vale': '山谷',
    'park bench': '公园长椅',
    'fountain': '喷泉',
    'library': '图书馆',
    'bookshop, bookstore, bookstall': '书店',
    'toyshop': '玩具店',
    'bakery, bakeshop, bakehouse': '面包店',
    'barber chair': '理发椅',
    'cinema, movie theater, movie theatre, movie house, picture palace': '电影院',
    'stage': '舞台',
    'scoreboard': '记分牌',
    'tennis ball': '网球',
    'racket, racquet': '球拍',
    'soccer ball': '足球',
    'basketball': '篮球',
    'volleyball': '排球',
    'baseball': '棒球',
    'sunglasses, dark glasses, shades': '太阳镜',
    'jersey, t-shirt, tee shirt': 'T恤/运动衫',
    'jean, blue jean, denim': '牛仔裤',
    'suit, suit of clothes': '西装',
    'swimming trunks, bathing trunks': '泳裤',
    'bikini, two-piece': '比基尼',
    'miniskirt, mini': '超短裙',
    'umbrella': '雨伞',
    'backpack, back pack, knapsack, packsack, rucksack, haversack': '背包',
    'purse': '钱包',
    'wallet, billfold, notecase, pocketbook': '皮夹',
};

/**
 * Translate a label to the target language
 * @param label The raw label from MobileNet (usually English)
 * @param lang The target language code ('en' or 'zh')
 */
export function translateLabel(label: string, lang: 'en' | 'zh'): string {
    if (!label) return '';

    // Normalize label for lookup (lowercase)
    const normalized = label.toLowerCase().trim();

    if (lang === 'zh') {
        const translation = LABEL_MAP_ZH[normalized];
        if (translation) {
            return translation;
        }

        // If no direct match, try to split by comma and translate part
        // Many labels are like "cat, feline"
        const parts = normalized.split(',').map(p => p.trim());
        for (const part of parts) {
            if (LABEL_MAP_ZH[part]) {
                return LABEL_MAP_ZH[part];
            }
        }
    }

    // Default: Capitalize first letter
    return label.charAt(0).toUpperCase() + label.slice(1);
}
