export default {
    tab_photos: 'Photos',
    tab_videos: 'Videos',
    tab_scan_results: 'AI Scan',
    tab_settings: 'Settings',

    permission_title: 'Access Required',
    permission_desc: 'PickPic needs access to your library to help you organize photos and videos.',
    permission_btn: 'Grant Permission',

    photos_header: 'Organizing',
    photos_empty: 'No more photos',
    photos_reload: 'Reload',
    photos_finished: 'Batch Complete',
    photos_delete_count: 'Delete: {count} items',
    photos_confirm: 'Confirm Delete',
    photos_skip: 'Skip Delete',

    hint_swipe_up: 'Swipe Up to Delete',
    hint_swipe_down: 'Swipe Down to Keep',
    hint_drop_new: 'New',

    video_delete: 'Delete',
    video_favorite: 'Favorite',
    video_share: 'Share',
    video_trash_title: 'Trash (Pending)',
    video_restore: 'Restore',
    video_confirm_delete: 'Delete Permanently',
    video_empty: 'No Videos',

    settings_title: 'Settings',
    settings_group_size: 'Batch Size',
    settings_collections: 'Enable Collections',
    settings_selected_collections: 'Selected {count} albums',
    settings_change: 'Change',
    settings_random: 'Random Display',
    settings_theme: 'Theme',
    theme_WarmTerra: 'Warm Terra',
    theme_light: 'Light',
    settings_language: 'Language',

    album_select_title: 'Select Albums (Max 4)',
    album_new_title: 'New Album',
    album_create_btn: 'Create & Add',
    cancel: 'Cancel',
    confirm: 'Confirm',

    // New keys v0.1.1
    settings_progress_photos: 'Photos Organized: {processed} / {total}',
    settings_progress_videos: 'Videos Organized: {processed} / {total}',
    settings_reset_photos: 'Reset Photo Review Progress',
    settings_reset_videos: 'Reset Video Review Progress',
    settings_reset_confirm: 'Confirm Reset?',
    settings_reset_desc: 'This will reset your progress tracking.',
    random_display_hint: 'Applies to both photos and videos',
    github_follow: 'Follow on GitHub',

    announcement_title: 'Welcome to PickPic',
    announcement_notice_title: 'Important Notice',
    announcement_notice_1: 'On some devices, deleted items may be permanently removed instead of going to the trash/recycle bin. Please proceed with caution.',
    announcement_notice_2: 'If cloud sync (iCloud/Mi Cloud) is enabled, we can only delete local files. Cloud backups may restore deleted items.',
    announcement_notice_3: 'This app is in beta testing. Please report any issues you encounter.',
    announcement_author_title: 'About Author',
    announcement_close_once: 'Close',
    announcement_close_version: "Don't show for this version",
    video_muted: 'Muted',
    video_sound: 'Sound',
    trash_empty: 'Empty',

    // New keys v0.2.0
    settings_display_order: 'Display Order',
    display_order_newest: 'Newest First',
    display_order_oldest: 'Oldest First',
    display_order_random: 'Random',
    settings_album_filter: 'Albums to Organize',
    album_filter_all: 'All Albums',
    album_filter_selected: '{count} Albums Selected',
    album_selector_title: 'Select Albums to Organize',
    thumbnail_tap_undo: 'Tap to undo, Long press to preview',
    no_delete_this_batch: 'No photos marked for deletion in this batch',
    continue_next_batch: 'Continue to Next Batch',

    // Version history
    announcement_update_title: "What's New",
    update_v030_1: '🔍 AI Scanning Engine: Auto-detect blurry & duplicate photos, with smart classification in Dev Options (Beta, fully offline, privacy-safe)',
    update_v030_2: '🎨 Unified Dialog UI: Refreshed visual experience with smoother interactions',
    update_v030_3: '⚡ Performance Boost: Faster startup and smoother scanning',

    // Developer options
    settings_dev_options: 'Developer Options',
    settings_dev_options_hint: 'Tap to expand/collapse',
    settings_enable_ai_classification: 'Enable AI Classification',
    settings_enable_ai_classification_hint: 'Classify images during scan (slower)',

    // AI Scanner labels
    ai_scanner_failed: 'Failed',
    ai_scanner_error: 'Error',
    scan_batch: 'Scan Batch',
    scan_batch_by_album: 'By Album',
    scan_batch_by_count: 'By Count',
    scan_batch_count_label: '{count} photos',
    scan_batch_start: 'Start Scan',

    // Similar photos
    similar_group_processed: 'Processed',
    similar_group_detail_title: 'Similar Photos',
    similar_select_hint: 'Long press to select, tap to preview',
    similar_delete_selected: 'Delete Selected',

    // Scan Results tabs
    scan_tab_blur: 'Blurry',
    scan_tab_similar: 'Similar',
    scan_tab_ai: 'AI Categories',

    // AI Categories
    ai_category_people: 'People',
    ai_category_people_single: 'Single Person',
    ai_category_people_group: 'Group Photo',
    ai_category_cat: 'Cat',
    ai_category_dog: 'Dog',
    ai_category_bird: 'Bird',
    ai_category_screenshot: 'Screenshots & Docs',
    ai_category_other: 'Other',

    // AI Scan Guide Modal
    ai_guide_title: 'New Feature: AI Scanning Engine',
    ai_guide_message: 'v0.3.1 introduces AI Scanning Engine to automatically analyze blurry and duplicate photos. Start background scan now?',
    ai_guide_privacy: '🔒 Fully offline, no internet required, privacy-safe',
    ai_guide_start: 'Start Now',
    ai_guide_dismiss: 'Don\'t Show for This Version',

    // AI Scan Empty Prompt
    ai_guide_classification_hint: '💡 Tip: You can enable powerful "AI Smart Classification" in "Settings -> Developer Options".',
    ai_scan_empty_title: 'No Scan Results',
    ai_scan_empty_message: 'Please go to Settings to start AI scanning to view classification results.',
    ai_scan_empty_close: 'Close',
    ai_scan_empty_dismiss_version: 'Don\'t Show for This Version',

    ai_classification_warning_title: 'Enable AI Classification',
    ai_classification_warning_message: 'Scan speed will be slower when enabled.\n\nNote: To apply this to existing photos, you must manually reset "Reset Scan Progress" and restart scan.',
    ai_classification_warning_confirm: 'Enable',
    ai_classification_warning_cancel: 'Cancel',

};
