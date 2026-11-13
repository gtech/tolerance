package lol.tolerance.android.ui.onboarding

import android.accessibilityservice.AccessibilityServiceInfo
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Process
import android.provider.Settings
import android.view.accessibility.AccessibilityManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
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
 * First run: the accessibility permission, walked through tap by tap, then a quick setup of
 * the choices we shouldn't make for people. The permission comes first so nobody has to read
 * or decide anything before Tolerance is on; the setup questions have defaults and can be
 * skipped with one tap. Setup runs once even if the service is already on (e.g. after an
 * update that adds a question); after that the launcher icon opens Settings.
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
                    firstRun = prefs.getInt(PREF_SETUP_VERSION, 0) == 0,
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
                    // The service brings this screen back once it's switched on, so nobody
                    // is left stranded in Android's settings
                    onOpenAccessibilitySettings = {
                        prefs.edit().putBoolean(ToleranceAccessibilityService.PREF_RETURN_AFTER_ENABLE, true).apply()
                        // The extras ask Settings to scroll to Tolerance's row and flash it,
                        // so there's no hunting through the list. Settings apps that don't
                        // know them ignore them.
                        val row = ComponentName(this, ToleranceAccessibilityService::class.java).flattenToString()
                        startActivity(
                            Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)
                                .putExtra(":settings:fragment_args_key", row)
                                .putExtra(":settings:show_fragment_args", Bundle().apply { putString(":settings:fragment_args_key", row) })
                        )
                    },
                    onOpenAppInfo = {
                        prefs.edit().putBoolean(ToleranceAccessibilityService.PREF_RETURN_AFTER_ENABLE, true).apply()
                        // "uId" is not optional: Android 13's App Info decides whether to show
                        // "Allow restricted settings" by this uid, and reads it only from the
                        // intent. Without it the ⋮ menu never appears (seen on a Pixel 4,
                        // TP1A.221005; AppInfoDashboardFragment.getUid).
                        startActivity(
                            Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", packageName, null))
                                .putExtra("uId", Process.myUid())
                        )
                    },
                    isServiceEnabled = { isAccessibilityServiceEnabled() },
                    onDone = {
                        prefs.edit()
                            .putInt(PREF_SETUP_VERSION, SETUP_VERSION)
                            .remove(ToleranceAccessibilityService.PREF_RETURN_AFTER_ENABLE)
                            .apply()
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

@Composable
private fun OnboardingScreen(
    firstRun: Boolean,
    initialHideLive: Boolean,
    initialHideAi: Boolean,
    initialHideShorts: Boolean,
    onSetupChosen: (hideLive: Boolean, hideAi: Boolean, hideShorts: Boolean) -> Unit,
    onOpenAccessibilitySettings: () -> Unit,
    onOpenAppInfo: () -> Unit,
    isServiceEnabled: () -> Boolean,
    onDone: () -> Unit,
) {
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
        // The permission first, with nothing to read or decide before it; the page turns
        // to setup by itself once the service is on
        if (!serviceEnabled) {
            PermissionTutorial(onOpenAccessibilitySettings, onOpenAppInfo)
        } else {
                // First run arrives here straight from switching the service on
                Heading(if (firstRun) "Tolerance is on" else "Quick setup")
                Body(
                    "Three optional choices. Skip them and nothing extra is hidden; you can change " +
                        "them any time in Settings."
                )
                SecondaryButton("Skip", onDone, Modifier.fillMaxWidth())
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
                    onDone()
                }, Modifier.fillMaxWidth())
        }
    }
}

/**
 * The accessibility permission, one tap at a time. Android's own flow is four screens deep,
 * blocks sideloaded apps part way through, and ends on an alarming warning; each step here
 * shows a sketch of the screen to expect and what to tap on it.
 */
@Composable
private fun PermissionTutorial(onOpenAccessibilitySettings: () -> Unit, onOpenAppInfo: () -> Unit) {
    // Android 13+ blocks accessibility for apps installed from a browser until the user
    // allows "restricted settings" for that app. The Play build never meets this.
    val restricted = BuildConfig.GITHUB_UPDATES && Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
    var step = 0

    Heading("Turn on Tolerance")
    Body(
        "Tolerance covers the junk in Twitter, TikTok and YouTube. To see those feeds it needs " +
            "Android's accessibility permission, which takes a few taps:"
    )

    if (restricted) {
        // Sideloaded: Tolerance starts greyed out in the list. Tapping it anyway is a real
        // step, not a dead end: Android only offers "Allow restricted settings" after it
        // has shown its "Restricted setting" message once.
        StepCard(++step, "Tap Tolerance, even though it's greyed out") {
            MockScreen {
                MockLabel("Downloaded apps")
                MockRow("Tolerance", highlight = true, dimmed = true)
            }
            StepText(
                "Android will say the setting is unavailable. That's expected, and it isn't the end: " +
                    "tap OK, then come back here for step 2, which unlocks it."
            )
            MockScreen {
                Text("Restricted setting", color = ToleranceColors.Text, fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
                Text("For your security, this setting is currently unavailable.", color = ToleranceColors.Muted, fontSize = 13.sp, lineHeight = 18.sp)
                MockRow("OK", highlight = true)
            }
            PrimaryButton("Open Accessibility Settings", onOpenAccessibilitySettings, Modifier.fillMaxWidth())
            StepText("Not greyed out? Tap it and skip to step 3.", faint = true)
        }

        StepCard(++step, "Allow restricted settings") {
            StepText("Tap ⋮ at the top right, then \"Allow restricted settings\".")
            MockScreen {
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    MockLabel("App info")
                    Text("⋮", color = ToleranceColors.PrimaryButtonText, fontSize = 18.sp, fontWeight = FontWeight.Bold)
                }
                MockRow("Allow restricted settings", highlight = true)
            }
            PrimaryButton("Open App Info", onOpenAppInfo, Modifier.fillMaxWidth())
            StepText("No ⋮ menu? Do step 1 first: it appears only after Android has shown \"Restricted setting\".", faint = true)
        }

        StepCard(++step, "Turn on \"Use Tolerance\"") {
            StepText("Back in the list, Tolerance is no longer greyed out. Tap it and turn on the first switch.")
            UseToleranceMock()
            PrimaryButton("Open Accessibility Settings", onOpenAccessibilitySettings, Modifier.fillMaxWidth())
        }
    } else {
        StepCard(++step, "Find Tolerance in the list") {
            MockScreen {
                MockLabel("Downloaded apps")
                MockRow("Tolerance", trailing = "Off", highlight = true)
            }
            PrimaryButton("Open Accessibility Settings", onOpenAccessibilitySettings, Modifier.fillMaxWidth())
        }

        StepCard(++step, "Turn on \"Use Tolerance\"") {
            UseToleranceMock()
        }
    }

    StepCard(++step, "Tap Allow") {
        StepText(
            "Android shows this warning for every accessibility app. Tolerance only reads those " +
                "three apps and draws covers; it never taps or types for you."
        )
        MockScreen {
            Text("Allow Tolerance to have full control of your device?", color = ToleranceColors.Text, fontSize = 13.sp, lineHeight = 18.sp)
            Row(Modifier.fillMaxWidth().padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                MockRow("Deny", modifier = Modifier.weight(1f))
                MockRow("Allow", highlight = true, modifier = Modifier.weight(1f))
            }
        }
        StepText("Tolerance opens again by itself once it's on.", faint = true)
    }

    Text(
        "Post text is sent to the scoring API (OpenRouter) and scores are cached on your device.",
        color = ToleranceColors.Faint, fontSize = 13.sp, lineHeight = 19.sp,
    )
}

/** Tolerance's page in Accessibility: two switches, and only the first one matters. */
@Composable
private fun UseToleranceMock() {
    MockScreen {
        MockRow("Use Tolerance", switch = true, highlight = true)
        // The second switch only adds a floating button that does nothing for Tolerance
        MockRow("Tolerance shortcut", trailing = "leave off", dimmed = true)
    }
}

@Composable
private fun StepCard(number: Int, title: String, content: @Composable ColumnScope.() -> Unit) {
    DashboardCard("Step $number", feature = true) {
        Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(title, color = ToleranceColors.Heading, fontSize = 17.sp, fontWeight = FontWeight.SemiBold)
            content()
        }
    }
}

@Composable
private fun StepText(text: String, faint: Boolean = false) {
    Text(
        text,
        color = if (faint) ToleranceColors.Faint else ToleranceColors.Muted,
        fontSize = if (faint) 13.sp else 14.sp,
        lineHeight = 21.sp,
    )
}

/** A sketch of the Android screen a step lands on, so the real one is recognisable. */
@Composable
private fun MockScreen(content: @Composable ColumnScope.() -> Unit) {
    val shape = RoundedCornerShape(10.dp)
    Column(
        Modifier
            .fillMaxWidth()
            .background(ToleranceColors.Page, shape)
            .border(BorderStroke(1.dp, ToleranceColors.FieldBorder), shape)
            .padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
        content = content,
    )
}

@Composable
private fun MockLabel(text: String) {
    Text(text, color = ToleranceColors.Faint, fontSize = 12.sp)
}

/** One row of a sketched screen. [highlight] marks the thing to tap. */
@Composable
private fun MockRow(
    text: String,
    modifier: Modifier = Modifier,
    trailing: String? = null,
    switch: Boolean = false,
    highlight: Boolean = false,
    dimmed: Boolean = false,
) {
    val shape = RoundedCornerShape(8.dp)
    val textColor = when {
        dimmed -> ToleranceColors.Faint
        highlight -> ToleranceColors.Heading
        else -> ToleranceColors.Muted
    }
    Row(
        modifier
            .fillMaxWidth()
            .background(if (highlight) ToleranceColors.PrimaryButton else ToleranceColors.Field, shape)
            .border(BorderStroke(1.dp, if (highlight) ToleranceColors.PrimaryButtonText else ToleranceColors.FieldBorder), shape)
            .padding(horizontal = 12.dp, vertical = 10.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(text, color = textColor, fontSize = 14.sp)
        if (trailing != null) Text(trailing, color = if (dimmed) ToleranceColors.Faint else ToleranceColors.Muted, fontSize = 13.sp)
        if (switch) {
            // An off switch: the state it's in when the user arrives
            Box(
                Modifier
                    .size(width = 34.dp, height = 18.dp)
                    .background(ToleranceColors.ToggleOff, RoundedCornerShape(9.dp))
                    .padding(3.dp),
            ) {
                Box(Modifier.size(12.dp).background(ToleranceColors.Muted, RoundedCornerShape(6.dp)))
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
