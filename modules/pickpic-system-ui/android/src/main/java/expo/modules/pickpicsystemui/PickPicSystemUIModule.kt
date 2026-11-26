package expo.modules.pickpicsystemui

import android.view.View
import android.view.ViewGroup
import androidx.core.view.WindowInsetsControllerCompat
import com.facebook.react.views.modal.ReactModalHostView
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/** RN 0.81 copies activity bar appearance into a dialog only on show.
 * Update existing RN dialogs in place; never recreate their children/drafts,
 * change the OS theme, access media, or touch unrelated app windows. */
class PickPicSystemUIModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("PickPicSystemUI")
    AsyncFunction("syncModalAppearance") { dark: Boolean ->
      val activity = appContext.currentActivity
      if (activity != null && !activity.isFinishing && !activity.isDestroyed) {
        fun visit(view: View) {
          if (view is ReactModalHostView) {
            val dialog = view.dialog
            val window = dialog?.window
            if (dialog?.isShowing == true && window != null) {
              val controller = WindowInsetsControllerCompat(window, window.decorView)
              controller.isAppearanceLightStatusBars = !dark
              controller.isAppearanceLightNavigationBars = !dark
              visit(window.decorView)
            }
            return
          }
          if (view is ViewGroup) {
            for (index in 0 until view.childCount) {
              view.getChildAt(index)?.let { visit(it) }
            }
          }
        }
        activity.window?.decorView?.let { visit(it) }
      }
      Unit
    }.runOnQueue(Queues.MAIN)
  }
}
