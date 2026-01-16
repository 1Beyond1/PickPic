export default {
    tab_photos: '图片',
    tab_videos: '视频',
    tab_scan_results: 'AI扫描',
    tab_settings: '设置',

    permission_title: '需访问权限',
    permission_desc: 'PickPic 需要访问您的照片库以帮助您整理照片和视频。',
    permission_btn: '授予权限',

    photos_header: '整理中',
    photos_empty: '没有更多照片了',
    photos_reload: '重新加载',
    photos_finished: '本组整理完成',
    photos_delete_count: '删除: {count} 张',
    photos_confirm: '确认删除并继续',
    photos_skip: '跳过删除并继续',

    hint_swipe_up: '上滑删除',
    hint_swipe_down: '下滑保留',
    hint_drop_new: '新建',

    video_delete: '删除',
    video_favorite: '收藏',
    video_share: '分享',
    video_trash_title: '废纸篓 (待删除)',
    video_restore: '撤回',
    video_confirm_delete: '确认彻底删除',
    video_empty: '没有视频',

    settings_title: '设置',
    settings_group_size: '每组照片数量',
    settings_collections: '启用收藏整理',
    settings_selected_collections: '已选 {count} 个收藏夹',
    settings_change: '修改',
    settings_random: '随机展示内容',
    settings_theme: '主题',
    theme_WarmTerra: 'Warm Terra',
    theme_light: '浅色',
    settings_language: '语言',

    album_select_title: '选择收藏夹 (最多4个)',
    album_new_title: '新建收藏夹',
    album_create_btn: '创建并收藏',
    cancel: '取消',
    confirm: '确认选择',

    // New keys v0.1.1
    settings_progress_photos: '已整理: {processed} 张 / 共 {total} 张',
    settings_progress_videos: '已整理: {processed} 个 / 共 {total} 个',
    settings_reset_photos: '重置图片整理进度',
    settings_reset_videos: '重置视频整理进度',
    settings_reset_confirm: '确认重置?',
    settings_reset_desc: '这将清除当前进度的记录。',
    random_display_hint: '对图片和视频都生效',
    github_follow: '关注 GitHub 获取后续更新',

    announcement_title: '欢迎使用 PickPic',
    announcement_notice_title: '使用须知',
    announcement_notice_1: '在本软件中删除的照片/视频，在部分机型上会被直接清除，而非移动到回收站。请谨慎操作！',
    announcement_notice_2: '如果您开启了云相册同步功能（如小米云、iCloud），我们仅能删除本机文件，无法删除云端备份。删除后可能会因云同步而恢复。',
    announcement_notice_3: '本软件目前处于测试阶段，可能存在功能不稳定的情况。使用过程中如遇到问题，欢迎反馈！',
    announcement_author_title: '关于作者',
    announcement_close_once: '本次关闭',
    announcement_close_version: '此版本不再显示',
    video_muted: '静音',
    video_sound: '有声',
    trash_empty: '空空如也',

    // New keys v0.2.0
    settings_display_order: '展示顺序',
    display_order_newest: '最新优先',
    display_order_oldest: '最旧优先',
    display_order_random: '随机',
    settings_album_filter: '整理范围',
    album_filter_all: '全部相册',
    album_filter_selected: '已选 {count} 个相册',
    album_selector_title: '选择要整理的相册',
    thumbnail_tap_undo: '点击撤销，长按查看',
    no_delete_this_batch: '本组没有决定要删除的照片',
    continue_next_batch: '继续下一组',

    // Version history
    announcement_update_title: '本次更新',
    update_v030_1: '🔍 新增 AI 扫描引擎：自动识别模糊照片、重复照片，开发者选项可开启智能分类（Beta，完全本地化，无隐私泄露）',
    update_v030_2: '🎨 统一弹窗 UI 风格：全新视觉体验，操作更流畅',
    update_v030_3: '⚡ 软件性能优化：启动更快，扫描更流畅',

    // Developer options
    settings_dev_options: '开发者选项',
    settings_dev_options_hint: '点击展开/收起',
    settings_enable_ai_classification: '启用 AI 图片分类',
    settings_enable_ai_classification_hint: '开启后扫描时进行智能分类（较慢）',

    // AI Scanner labels
    ai_scanner_failed: '失败',
    ai_scanner_error: '错误',
    scan_batch: '扫描一批',
    scan_batch_by_album: '按相册扫描',
    scan_batch_by_count: '按数量扫描',
    scan_batch_count_label: '{count} 张',
    scan_batch_start: '开始扫描',

    // Similar photos
    similar_group_processed: '已整理',
    similar_group_detail_title: '相似照片组',
    similar_select_hint: '长按选中，单击查看详情',
    similar_delete_selected: '删除选中',

    // Scan Results tabs
    scan_tab_blur: '模糊',
    scan_tab_similar: '相似',
    scan_tab_ai: '智能分类',

    // AI Categories
    ai_category_people: '人物',
    ai_category_people_single: '单人照',
    ai_category_people_group: '多人合影',
    ai_category_cat: '猫',
    ai_category_dog: '狗',
    ai_category_bird: '鸟',
    ai_category_screenshot: '截图 & 文档',
    ai_category_other: '其他',

    // AI Scan Guide Modal
    ai_guide_title: '新功能：AI 扫描引擎',
    ai_guide_message: 'v0.3.1 新增 AI 扫描引擎,可自动分析模糊和重复照片。是否现在开始后台静默扫描?',
    ai_guide_privacy: '🔒 完全本地化，无需联网，隐私安全',
    ai_guide_start: '立即开始',
    ai_guide_dismiss: '此版本不再提示',
    ai_guide_classification_hint: '💡 提示：您可以在“设置 -> 开发者选项”中开启更强大的【AI 智能识图分类】功能。',

    // AI Scan Empty Prompt
    ai_scan_empty_title: '尚未进行扫描',
    ai_scan_empty_message: '请前往"设置"页面开始 AI 扫描，以查看分类结果。',
    ai_scan_empty_close: '关闭',
    ai_scan_empty_dismiss_version: '此版本不再提示',

    ai_classification_warning_title: '开启 AI 智能分类',
    ai_classification_warning_message: '开启此功能后，扫描速度会变慢。\n\n注意：如需对已有照片应用分类，请手动点击"重置扫描进度"并重新扫描。',
    ai_classification_warning_confirm: '开启',
    ai_classification_warning_cancel: '取消',

};
