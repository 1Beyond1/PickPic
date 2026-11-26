package expo.modules.pickpicmediaindex

import android.provider.MediaStore
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/** Only indexed size for requested media IDs. No paths, names, EXIF, original
 * bytes, network downloads or writes. Android still enforces media access. */
class PickPicMediaIndexModule : Module() {
  companion object {
    private val MEDIA_ID_REGEX = Regex("[1-9][0-9]{0,18}")
  }

  override fun definition() = ModuleDefinition {
    Name("PickPicMediaIndex")

    AsyncFunction("readSizes") { kind: String, requestedIds: List<String> ->
      require(kind == "photo" || kind == "video") { "Unsupported media type" }
      require(requestedIds.size <= 200) { "Media index batch is too large" }
      val ids = requestedIds.distinct()
      require(ids.all { it.matches(MEDIA_ID_REGEX) && it.toLongOrNull() != null }) { "Invalid media ID" }
      if (ids.isEmpty()) return@AsyncFunction emptyList<Map<String, Any?>>()
      val context = appContext.reactContext ?: throw IllegalStateException("Media index context unavailable")
      val uri = if (kind == "photo") MediaStore.Images.Media.EXTERNAL_CONTENT_URI else MediaStore.Video.Media.EXTERNAL_CONTENT_URI
      val projection = arrayOf(MediaStore.MediaColumns._ID, MediaStore.MediaColumns.SIZE)
      val selection = "${MediaStore.MediaColumns._ID} IN (${ids.joinToString(",") { "?" }})"
      val rows = mutableListOf<Map<String, Any?>>()
      val cursor = context.contentResolver.query(uri, projection, selection, ids.toTypedArray(), null)
        ?: throw IllegalStateException("Media index query unavailable")
      cursor.use {
        val idColumn = it.getColumnIndexOrThrow(MediaStore.MediaColumns._ID)
        val sizeColumn = it.getColumnIndexOrThrow(MediaStore.MediaColumns.SIZE)
        while (it.moveToNext()) {
          val bytes = if (it.isNull(sizeColumn)) null else it.getLong(sizeColumn)
          rows.add(mapOf("id" to it.getLong(idColumn).toString(), "bytes" to
            bytes?.takeIf { value -> value > 0 && value <= 9007199254740991L }?.toDouble()))
        }
      }
      rows
    }
  }
}
