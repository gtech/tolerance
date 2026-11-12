package lol.tolerance.android.ui.onboarding

import android.accessibilityservice.AccessibilityServiceInfo
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.view.accessibility.AccessibilityManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.material3.Text
import lol.tolerance.android.BuildConfig
import lol.tolerance.android.service.ToleranceAccessibilityService
import lol.tolerance.android.ui.settings.SettingsActivity
import lol.tolerance.android.ui.theme.*

/**
 * First run: welcome, a quick setup of the choices we shouldn't make for people, then the
 * accessibility permission. Setup runs once even if the service is already on (e.g. after
 * an update that adds a question); after that the launcher icon opens Settings.
 */
class OnboardingActivity : ComponentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val prefs = getSharedPreferences("tolerance_prefs", MODE_PRIVATE)

        if (isAccessibilityServiceEnabled() && prefs.getInt(PREF_SETUP_VERSION, 0) >= SETUP_VERSION) {
            openSettings()
            return
        }

        setContent {
            ToleranceTheme {
                OnboardingScreen(
                    startAtSetup = isAccessibilityServiceEnabled(),
                    initialHideLive = prefs.getBoolean(ToleranceAccessibilityService.PREF_HIDE_LIVE, false),
                    initialHideAi = prefs.getBoolean(ToleranceAccessibilityService.PREF_HIDE_AI, false),
                    initialHideShorts = prefs.getBoolean(ToleranceAccessibilityService.PREF_HIDE_SHORTS, false),
                    onSetupChosen = { hideLive, hideAi, hideShorts ->
                        prefs.edit()
                            .putBoolean(ToleranceAccessibilityService.PREF_HIDE_LIVE, hideLive)
                            .putBoolean(ToleranceAccessibilityService.PREF_HIDE_AI, hideAi)
                            .putBoolean(ToleranceAccessibilityService.PREF_HIDE_SHORTS, hideShorts)
                            .apply()
                    },
                    onOpenAccessibilitySettings = { startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)) },
                    onOpenAppInfo = {
                        startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", packageName, null)))
                    },
                    isServiceEnabled = { isAccessibilityServiceEnabled() },
                    onDone = {
                        prefs.edit().putInt(PREF_SETUP_VERSION, SETUP_VERSION).apply()
                        openSettings()
                    },
                )
            }
        }
    }

    private fun openSettings() {
        startActivity(Intent(this, SettingsActivity::class.java))
        finish()
    }

    private fun isAccessibilityServiceEnabled(): Boolean {
        val am = getSystemService(Context.ACCESSIBILITY_SERVICE) as AccessibilityManager
        val enabledServices = am.getEnabledAccessibilityServiceList(
            AccessibilityServiceInfo.FEEDBACK_GENERIC
        )
        return enabledServices.any {
            it.resolveInfo.serviceInfo.name == ToleranceAccessibilityService::class.java.name
        }
    }

    companion object {
        private const val PREF_SETUP_VERSION = "setup_version"
        // Bump when setup gains a question, so people who finished an older one see it once
        // more. 1: TikTok LIVE. 2: AI-generated videos. 3: YouTube Shorts.
        private const val SETUP_VERSION = 3
    }
}

private enum class Page { WELCOME, SETUP, PERMISSION }

@Composable
private fun OnboardingScreen(
    startAtSetup: Boolean,
    initialHideLive: Boolean,
    initialHideAi: Boolean,
    initialHideShorts: Boolean,
    onSetupChosen: (hideLive: Boolean, hideAi: Boolean, hideShorts: Boolean) -> Unit,
    onOpenAccessibilitySettings: () -> Unit,
    onOpenAppInfo: () -> Unit,
    isServiceEnabled: () -> Boolean,
    onDone: () -> Unit,
) {
    var page by remember { mutableStateOf(if (startAtSetup) Page.SETUP else Page.WELCOME) }
    var serviceEnabled by remember { mutableStateOf(isServiceEnabled()) }
    var hideLive by remember { mutableStateOf(initialHideLive) }
    var hideAi by remember { mutableStateOf(initialHideAi) }
    var hideShorts by remember { mutableStateOf(initialHideShorts) }

    // Check service status when returning from settings
    LaunchedEffect(Unit) {
        while (true) {
            kotlinx.coroutines.delay(1000)
            serviceEnabled = isServiceEnabled()
        }
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(ToleranceColors.Page)
            .verticalScroll(rememberScrollState())
            .systemBarsPadding()
            .padding(24.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Spacer(Modifier.height(32.dp))
        when (page) {
            Page.WELCOME -> {
                Heading("Tolerance")
                Body(
                    "Feeds are built from quick hits: posts that grab your attention for almost no effort " +
                        "and leave nothing behind. Tolerance scores each post for that cheap payoff and covers " +
                        "the worst of it, more the longer you scroll, so stopping gets easier.\n\n" +
                        "It works in Twitter, TikTok and YouTube."
                )
                PrimaryButton("Next", { page = Page.SETUP }, Modifier.fillMaxWidth())
            }

            Page.SETUP -> {
                Heading("Quick setup")
                Body("A couple of choices we'd rather you make. You can change them any time in Settings.")
                SetupQuestion(
                    "TikTok LIVE",
                    "Hide LIVE streams? A stream has nothing in it to score, so Tolerance can't tell one " +
                        "from another: it's all or nothing. Hidden streams are covered and muted, and you " +
                        "can still swipe past or go back.",
                    hideLabel = "Hide LIVE", keepLabel = "Keep LIVE",
                    hide = hideLive, onChoose = { hideLive = it },
                )
                SetupQuestion(
                    "AI-generated videos",
                    "Hide videos labeled as AI-generated? This uses TikTok's label and the creator's own, " +
                        "so unlabeled AI videos still get through. Hidden videos are covered and muted.",
                    hideLabel = "Hide AI", keepLabel = "Keep AI",
                    hide = hideAi, onChoose = { hideAi = it },
                )
                SetupQuestion(
                    "YouTube Shorts",
                    "Hide Shorts? A Short shows no channel or views to score by, so it's all or nothing: " +
                        "the Shorts shelves in your feed and the Shorts player get covered, and the player muted.",
                    hideLabel = "Hide Shorts", keepLabel = "Keep Shorts",
                    hide = hideShorts, onChoose = { hideShorts = it },
                )
                PrimaryButton("Continue", {
                    onSetupChosen(hideLive, hideAi, hideShorts)
                    if (serviceEnabled) onDone() else page = Page.PERMISSION
                }, Modifier.fillMaxWidth())
            }

            Page.PERMISSION -> {
                Heading("Accessibility permission")
                Body(
                    "Tolerance needs accessibility access to read posts in Twitter, TikTok and" +
                        "YouTube, and to draw covers over them. It ignores every other app.\n\n" +
                        "Post text is sent to the scoring API (OpenRouter) and scores are cached on your device."
                )
                if (serviceEnabled) {
                    DashboardCard("Service enabled") {
                        PrimaryButton("Continue to Settings", onDone, Modifier.fillMaxWidth())
                    }
                } else {
                    PrimaryButton("Open Accessibility Settings", onOpenAccessibilitySettings, Modifier.fillMaxWidth())
                    Text(
                        "Find \"Tolerance\" in the list and turn it on.",
                        color = ToleranceColors.Faint, fontSize = 13.sp,
                    )
                    // Android 13+ greys out accessibility for apps installed from a browser
                    // until the user allows "restricted settings" for that app
                    if (BuildConfig.GITHUB_UPDATES && Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                        DashboardCard("Greyed out?", feature = true) {
                            Text(
                                "Android blocks accessibility for apps installed outside the Play Store until you allow it:\n" +
                                    "1. Tap Open App Info below\n" +
                                    "2. Tap ⋮ (top right), then \"Allow restricted settings\"\n" +
                                    "3. Come back and turn Tolerance on\n\n" +
                                    "No ⋮ menu? Try turning Tolerance on once first; the option appears after Android blocks it.",
                                color = ToleranceColors.Muted, fontSize = 14.sp, lineHeight = 21.sp,
                            )
                            SecondaryButton("Open App Info", onOpenAppInfo, Modifier.padding(top = 12.dp))
                        }
                    }
                }
            }
        }
    }
}

/** A hide-or-keep question: the chosen side shows as the primary button. */
@Composable
private fun SetupQuestion(
    title: String,
    description: String,
    hideLabel: String,
    keepLabel: String,
    hide: Boolean,
    onChoose: (Boolean) -> Unit,
) {
    DashboardCard(title, feature = true) {
        Text(description, color = ToleranceColors.Muted, fontSize = 14.sp, lineHeight = 21.sp)
        Row(Modifier.padding(top = 16.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            if (hide) {
                PrimaryButton("✓ $hideLabel", { onChoose(true) }, Modifier.weight(1f))
                SecondaryButton(keepLabel, { onChoose(false) }, Modifier.weight(1f))
            } else {
                SecondaryButton(hideLabel, { onChoose(true) }, Modifier.weight(1f))
                PrimaryButton("✓ $keepLabel", { onChoose(false) }, Modifier.weight(1f))
            }
        }
    }
}

@Composable
private fun Heading(text: String) {
    Text(text, color = ToleranceColors.Heading, fontSize = 28.sp, fontWeight = FontWeight.SemiBold)
}

@Composable
private fun Body(text: String) {
    Text(text, color = ToleranceColors.Text, fontSize = 15.sp, lineHeight = 22.sp)
}
