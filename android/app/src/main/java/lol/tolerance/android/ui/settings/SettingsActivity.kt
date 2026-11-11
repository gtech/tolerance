package lol.tolerance.android.ui.settings

import android.Manifest
import android.content.ClipboardManager
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import lol.tolerance.android.BuildConfig
import lol.tolerance.android.api.CreditMonitor
import lol.tolerance.android.api.KeyStore
import lol.tolerance.android.api.UpdateChecker
import lol.tolerance.android.scoring.OpenRouterClient
import lol.tolerance.android.boredom.ProgressiveBoredomTracker
import lol.tolerance.android.boredom.ProgressiveBoredomTracker.Phase
import lol.tolerance.android.boredom.Strictness
import lol.tolerance.android.scoring.Topic
import lol.tolerance.android.scoring.TopicStore
import lol.tolerance.android.service.ToleranceAccessibilityService
import lol.tolerance.android.ui.theme.*
import kotlin.math.ceil

class SettingsActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            ToleranceTheme {
                SettingsScreen()
            }
        }
    }
}

/** Laid out like the extension dashboard: one card per concern, most-used first. */
@Composable
fun SettingsScreen() {
    val context = LocalContext.current
    val keyStore = remember { KeyStore.getInstance(context) }
    val boredomTracker = remember { ProgressiveBoredomTracker(context) }
    val topicStore = remember { TopicStore(context) }
    val prefs = remember { context.getSharedPreferences("tolerance_prefs", 0) }

    fun pref(key: String, default: Boolean) = mutableStateOf(prefs.getBoolean(key, default))
    fun save(key: String, value: Boolean) = prefs.edit().putBoolean(key, value).apply()

    var blurUntilScored by remember { pref("blur_until_scored", true) }
    var penalizeAds by remember { pref("penalize_ads", true) }
    var debugScrollRuler by remember { pref("debug_scroll_ruler", false) }
    var hideLive by remember { pref(ToleranceAccessibilityService.PREF_HIDE_LIVE, false) }
    var hideAi by remember { pref(ToleranceAccessibilityService.PREF_HIDE_AI, false) }
    var hideShorts by remember { pref(ToleranceAccessibilityService.PREF_HIDE_SHORTS, false) }

    // Phase changes and running out of scoring credit are told by notification; Android 13+
    // needs permission for that. Asked once.
    val notificationPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {}
    LaunchedEffect(Unit) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED &&
            !prefs.getBoolean(PREF_ASKED_NOTIFICATIONS, false)
        ) {
            prefs.edit().putBoolean(PREF_ASKED_NOTIFICATIONS, true).apply()
            notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(ToleranceColors.Page)
            .verticalScroll(rememberScrollState())
            .systemBarsPadding()
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Text(
            "Tolerance",
            color = ToleranceColors.Heading,
            fontSize = 24.sp,
            fontWeight = FontWeight.SemiBold,
            modifier = Modifier.padding(top = 8.dp, bottom = 8.dp),
        )
        HorizontalDivider(color = ToleranceColors.Hairline)

        if (BuildConfig.GITHUB_UPDATES) UpdateCard()
        BoredomCard(boredomTracker)
        StrictnessCard(boredomTracker)
        TopicsCard(topicStore)

        FeatureToggleCard(
            "Blur Until Scored",
            "Cover posts while waiting for AI scoring. Turn off to cover only once a score is in. " +
                "If scoring is slow, a post is revealed after 15 seconds.",
            blurUntilScored,
        ) { blurUntilScored = it; save("blur_until_scored", it) }

        // Not in the Play build, which leaves ads alone
        if (BuildConfig.AD_BLOCKING) {
            FeatureToggleCard(
                "Penalize Ads",
                "Gives ads and sponsored posts the top score, so they're covered in every phase, " +
                    "even on a post you've opened.",
                penalizeAds,
            ) { penalizeAds = it; save("penalize_ads", it) }
        }

        FeatureToggleCard(
            "Hide TikTok LIVE",
            "Covers LIVE streams and mutes them. A stream has nothing to score, so it's all or nothing. " +
                "Touches still reach the stream: swipe on or go back.",
            hideLive,
        ) { hideLive = it; save(ToleranceAccessibilityService.PREF_HIDE_LIVE, it) }

        FeatureToggleCard(
            "Hide AI-Generated Videos",
            "Covers and mutes TikTok videos labeled as AI-generated, by TikTok or by the creator, " +
                "including from creators you follow. Only labeled videos are caught.",
            hideAi,
        ) { hideAi = it; save(ToleranceAccessibilityService.PREF_HIDE_AI, it) }

        FeatureToggleCard(
            "Hide YouTube Shorts",
            "Covers the Shorts shelves in your feed and the Shorts player, and mutes the player. " +
                "Shorts don't show enough to score, so it's all or nothing.",
            hideShorts,
        ) { hideShorts = it; save(ToleranceAccessibilityService.PREF_HIDE_SHORTS, it) }

        ScoreTagCard(prefs)
        PlatformsCard(prefs)
        ApiCard(keyStore)

        DashboardCard("Debug") {
            SettingRow(
                "Show scroll ruler over content",
                "White ticks should stay pinned to the content. Red ticks are raw ScrollY, unfiltered.",
            ) {
                DashboardSwitch(debugScrollRuler) { debugScrollRuler = it; save("debug_scroll_ruler", it) }
            }
        }

        Spacer(Modifier.height(16.dp))
    }
}

// --- Updates (sideloaded build) ---

/** Shown only when GitHub has a newer release than this build. */
@Composable
private fun UpdateCard() {
    val context = LocalContext.current
    val checker = remember { UpdateChecker(context) }
    var update by remember { mutableStateOf<UpdateChecker.Release?>(null) }
    LaunchedEffect(Unit) { update = checker.availableUpdate() }

    val release = update ?: return
    DashboardCard("Update available", feature = true) {
        Text(
            "Tolerance ${release.version} is out (you have ${BuildConfig.VERSION_NAME}). " +
                "Download it, then open the file to install over this version. Your settings stay.",
            color = ToleranceColors.Muted, fontSize = 13.sp, lineHeight = 19.sp,
        )
        Row(Modifier.padding(top = 12.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            PrimaryButton("Download", {
                context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(release.apkUrl ?: release.pageUrl)))
            })
            SecondaryButton("What's new", {
                context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(release.pageUrl)))
            })
        }
    }
}

// --- Progressive boredom ---

@Composable
private fun BoredomCard(tracker: ProgressiveBoredomTracker) {
    var enabled by remember { mutableStateOf(tracker.isEnabled()) }
    val phase = remember(enabled) { tracker.getCurrentPhase() }
    val minutes = remember { tracker.getTotalMinutes() }
    val saved = remember { tracker.getPhaseThresholds() }
    var normal by remember { mutableStateOf(saved.normal.toInt().toString()) }
    var reduced by remember { mutableStateOf(saved.reduced.toInt().toString()) }
    var windDown by remember { mutableStateOf(saved.windDown.toInt().toString()) }
    var showTiming by remember { mutableStateOf(false) }

    fun timing() = ProgressiveBoredomTracker.PhaseThresholds(
        normal = normal.toDoubleOrNull() ?: ProgressiveBoredomTracker.DEFAULT_NORMAL_MINUTES,
        reduced = reduced.toDoubleOrNull() ?: ProgressiveBoredomTracker.DEFAULT_REDUCED_MINUTES,
        windDown = windDown.toDoubleOrNull() ?: ProgressiveBoredomTracker.DEFAULT_WIND_DOWN_MINUTES,
    )

    DashboardCard("Progressive Boredom", action = {
        DashboardSwitch(enabled) { enabled = it; tracker.setEnabled(it) }
    }) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Text("${minutes.toInt()}m", color = ToleranceColors.Heading, fontSize = 28.sp, fontWeight = FontWeight.SemiBold)
            Column {
                PhaseBadge(phase)
                Text("Today's social media time", color = ToleranceColors.Faint, fontSize = 11.sp,
                    modifier = Modifier.padding(top = 4.dp))
            }
        }

        val t = timing()
        val ends = listOf(t.normal, t.reduced, t.windDown, t.windDown + LAST_SEGMENT_MINUTES)
        Row(Modifier.fillMaxWidth().padding(top = 12.dp), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            Phase.entries.forEachIndexed { i, p ->
                val start = if (i == 0) 0.0 else ends[i - 1]
                val fill = ((minutes - start) / (ends[i] - start)).coerceIn(0.0, 1.0).toFloat()
                Box(Modifier.weight(1f).height(8.dp).clip(RoundedCornerShape(4.dp)).background(ToleranceColors.Hairline)) {
                    Box(Modifier.fillMaxHeight().fillMaxWidth(fill).background(ToleranceColors.phase(p).second))
                }
            }
        }
        Row(Modifier.fillMaxWidth().padding(top = 4.dp), horizontalArrangement = Arrangement.SpaceBetween) {
            listOf("0", "${t.normal.toInt()}m", "${t.reduced.toInt()}m", "${t.windDown.toInt()}m", "${ends[3].toInt()}m+")
                .forEach { Text(it, color = ToleranceColors.Faint, fontSize = 10.sp) }
        }
        Text(
            if (enabled) "Covers more as your day's scrolling goes on. Resets at 4am."
            else "Off: the day stays in Normal, so only Normal's threshold applies.",
            color = ToleranceColors.Faint, fontSize = 11.sp, modifier = Modifier.padding(top = 8.dp),
        )

        Text(
            if (showTiming) "Hide phase timing" else "Phase timing",
            color = ToleranceColors.Muted, fontSize = 12.sp,
            modifier = Modifier.padding(top = 12.dp).clickable { showTiming = !showTiming },
        )
        if (showTiming) {
            MinutesField("Reduced starts at (min)", normal) { normal = it; tracker.setPhaseThresholds(timing()) }
            MinutesField("Wind-down starts at (min)", reduced) { reduced = it; tracker.setPhaseThresholds(timing()) }
            MinutesField("Minimal starts at (min)", windDown) { windDown = it; tracker.setPhaseThresholds(timing()) }
        }
    }
}

@Composable
private fun PhaseBadge(phase: Phase) {
    val (bg, fg) = ToleranceColors.phase(phase)
    Text(
        phase.label.uppercase(),
        color = fg,
        fontSize = 12.sp,
        fontWeight = FontWeight.SemiBold,
        modifier = Modifier.clip(RoundedCornerShape(4.dp)).background(bg).padding(horizontal = 10.dp, vertical = 4.dp),
    )
}

// --- Strictness ---

@Composable
private fun StrictnessCard(tracker: ProgressiveBoredomTracker) {
    var level by remember { mutableIntStateOf(tracker.getStrictness()) }
    val preset = Strictness.preset(level)
    val phase = remember { tracker.getCurrentPhase() }
    val threshold = preset.thresholds.forPhase(phase)

    DashboardCard("Blur Thresholds") {
        Row {
            Text("Strictness: ", color = Color(0xFFCCCCCC), fontSize = 13.sp)
            Text(preset.label, color = ToleranceColors.Heading, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
        }
        Slider(
            value = level.toFloat(),
            onValueChange = { level = it.toInt() },
            onValueChangeFinished = { tracker.setStrictness(level) },
            valueRange = 1f..Strictness.PRESETS.size.toFloat(),
            steps = Strictness.PRESETS.size - 2,
        )
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            listOf("Gentle", "Default", "Strict").forEach { Text(it, color = ToleranceColors.Faint, fontSize = 11.sp) }
        }
        Text(
            "How much gets covered as your session goes on. Moves all four phase thresholds together.",
            color = ToleranceColors.Faint, fontSize = 11.sp, modifier = Modifier.padding(top = 8.dp),
        )
        Text(
            "Now (${phase.label}): " + if (threshold >= Strictness.MAX_THRESHOLD) "only 10s are covered: " + (if (BuildConfig.AD_BLOCKING) "ads and hidden topics" else "hidden topics")
            else "posts scoring ${ceil(threshold / 10.0).toInt()} or more are covered",
            color = Color(0xFFAAAAAA), fontSize = 12.sp, modifier = Modifier.padding(top = 10.dp),
        )
    }
}

// --- Topics ---

@Composable
private fun TopicsCard(store: TopicStore) {
    var topics by remember { mutableStateOf(store.topics()) }
    val hits = remember(topics) { store.hits() }
    var input by remember { mutableStateOf("") }
    var note by remember { mutableStateOf("") }

    fun add(hide: Boolean) {
        val topic = store.add(input, hide) ?: run { note = "Describe a topic first."; return }
        topics = store.topics()
        input = ""
        note = if (topic.hide) "Hiding \"${topic.name}\" from now on." else "Always showing \"${topic.name}\" from now on."
    }

    DashboardCard("Topics") {
        Text(
            "Describe something in your own words, then choose whether to hide it or always show it in every app.",
            color = ToleranceColors.Muted, fontSize = 13.sp, modifier = Modifier.padding(bottom = 12.dp),
        )
        DashboardField(input, { input = it }, "e.g. a game you're sick of, vague attention-seeking posts, woodworking")
        Row(Modifier.padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            PrimaryButton("Hide it", { add(hide = true) })
            SecondaryButton("Show it", { add(hide = false) })
        }
        if (note.isNotEmpty()) Text(note, color = Color(0xFFAAAAAA), fontSize = 12.sp, modifier = Modifier.padding(top = 8.dp))

        for (topic in topics) {
            TopicRow(topic, hits[topic.id]?.count ?: 0, hits[topic.id]?.recent.orEmpty()) {
                store.remove(topic.id)
                topics = store.topics()
                note = ""
            }
        }
    }
}

@Composable
private fun TopicRow(topic: Topic, count: Int, recent: List<String>, onRemove: () -> Unit) {
    var showRecent by remember { mutableStateOf(false) }
    val posts = "$count ${if (count == 1) "post" else "posts"}"
    val status = when {
        !topic.hide -> if (count == 0) "Always shown. Nothing matched yet today" else "Always shown. Kept $posts visible today"
        else -> if (count == 0) "Hidden. Nothing caught yet today" else "Hidden. Caught $posts today"
    }
    HorizontalDivider(color = ToleranceColors.Hairline, modifier = Modifier.padding(top = 12.dp))
    Row(Modifier.fillMaxWidth().padding(top = 12.dp), horizontalArrangement = Arrangement.spacedBy(16.dp)) {
        Column(Modifier.weight(1f)) {
            Text(topic.name, color = ToleranceColors.Text, fontSize = 14.sp)
            Text(status, color = ToleranceColors.Muted, fontSize = 12.sp, modifier = Modifier.padding(top = 2.dp))
            if (recent.isNotEmpty()) {
                Text(
                    if (showRecent) "▾ What it matched" else "▸ What it matched",
                    color = ToleranceColors.Muted, fontSize = 12.sp,
                    modifier = Modifier.padding(top = 6.dp).clickable { showRecent = !showRecent },
                )
                if (showRecent) recent.forEach {
                    Text("• $it", color = ToleranceColors.Muted, fontSize = 12.sp, modifier = Modifier.padding(start = 8.dp, top = 4.dp))
                }
            }
        }
        SecondaryButton("Remove", onRemove, small = true)
    }
}

// --- TikTok score tag ---

@Composable
private fun ScoreTagCard(prefs: android.content.SharedPreferences) {
    var position by remember {
        mutableStateOf(prefs.getString(ToleranceAccessibilityService.PREF_SCORE_TAG, ToleranceAccessibilityService.SCORE_TAG_MIDDLE))
    }
    DashboardCard("TikTok Score Tag") {
        Text(
            "A small tag on the left edge showing each video's score.",
            color = ToleranceColors.Muted, fontSize = 13.sp, modifier = Modifier.padding(bottom = 12.dp),
        )
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            listOf(
                ToleranceAccessibilityService.SCORE_TAG_TOP to "Top",
                ToleranceAccessibilityService.SCORE_TAG_MIDDLE to "Middle",
                ToleranceAccessibilityService.SCORE_TAG_OFF to "Off",
            ).forEach { (value, label) ->
                Choice(label, position == value, Modifier.weight(1f)) {
                    position = value
                    prefs.edit().putString(ToleranceAccessibilityService.PREF_SCORE_TAG, value).apply()
                }
            }
        }
    }
}

@Composable
private fun Choice(label: String, selected: Boolean, modifier: Modifier, onClick: () -> Unit) {
    val shape = RoundedCornerShape(6.dp)
    Text(
        label,
        color = if (selected) ToleranceColors.Heading else ToleranceColors.Muted,
        fontSize = 14.sp,
        textAlign = TextAlign.Center,
        modifier = modifier
            .clip(shape)
            .background(ToleranceColors.Field)
            .border(2.dp, if (selected) ToleranceColors.Toggle else ToleranceColors.FieldBorder, shape)
            .clickable(onClick = onClick)
            .padding(vertical = 10.dp),
    )
}

// --- Platforms and API ---

@Composable
private fun PlatformsCard(prefs: android.content.SharedPreferences) {
    DashboardCard("Platforms") {
        PLATFORMS.forEach { (key, name, note) ->
            var on by remember { mutableStateOf(prefs.getBoolean("platform_${key}_enabled", true)) }
            SettingRow(name, note) {
                DashboardSwitch(on) { on = it; prefs.edit().putBoolean("platform_${key}_enabled", it).apply() }
            }
        }
    }
}

/**
 * Free tier, or a key of your own — which is also how Pro works: buying it on the account
 * page gives you a key to paste here, as in the extension.
 */
@Composable
private fun ApiCard(keyStore: KeyStore) {
    val context = LocalContext.current
    val credits = remember { CreditMonitor(context) }
    val client = remember { OpenRouterClient(keyStore) }
    var tier by remember { mutableStateOf(keyStore.apiTier) }
    var ownKey by remember { mutableStateOf(keyStore.ownApiKey ?: "") }
    var exhausted by remember { mutableStateOf(credits.isExhausted()) }
    var keyStatus by remember { mutableStateOf<String?>(null) }
    // Bumped to re-check the key on demand
    var checks by remember { mutableIntStateOf(0) }

    // What OpenRouter says about the key in use: credit left, or refused
    LaunchedEffect(tier, checks) {
        val key = keyStore.getEffectiveApiKey()
        if (key.isNullOrBlank()) {
            keyStatus = if (tier == "free") "Free key not set up yet: it's created when scoring first runs." else null
            return@LaunchedEffect
        }
        keyStatus = "Checking…"
        val check = client.checkKey(key)
        if (check is OpenRouterClient.KeyCheck.Ok && (check.remaining ?: 1.0) > 0) {
            credits.markWorking()
            exhausted = false
        }
        keyStatus = describeKey(check, freeTier = tier == "free")
    }

    fun useOwnKey(key: String) {
        ownKey = key
        keyStore.ownApiKey = key
        // A new key gets a fresh chance; the next scoring call will tell
        credits.markWorking()
        exhausted = false
    }

    DashboardCard("Scoring API") {
        if (exhausted) {
            Text(
                if (tier == "free") "Free credits are used up for this month, so posts aren't being scored."
                else "OpenRouter refused the key (error ${credits.refusalStatus()}), so posts aren't being scored.",
                color = Color(0xFFFFC107), fontSize = 13.sp, modifier = Modifier.padding(bottom = 12.dp),
            )
        }
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            TierOption("Free Tier", "Hosted scoring with a small monthly allowance", tier == "free", Modifier.weight(1f)) {
                tier = "free"; keyStore.apiTier = "free"
            }
            TierOption("Pro or Own Key", "Paste your Pro key, or an OpenRouter key", tier == "own-key", Modifier.weight(1f)) {
                tier = "own-key"; keyStore.apiTier = "own-key"
            }
        }
        if (tier == "own-key") {
            Spacer(Modifier.height(12.dp))
            DashboardField(ownKey, { useOwnKey(it.trim()) }, "sk-or-...", secret = true)
            Row(Modifier.padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                SecondaryButton("Paste", {
                    val clip = context.getSystemService(ClipboardManager::class.java)
                        ?.primaryClip?.takeIf { it.itemCount > 0 }?.getItemAt(0)?.coerceToText(context)?.toString()?.trim()
                    if (clip != null && clip.startsWith(KEY_PREFIX)) {
                        useOwnKey(clip)
                        checks++
                    } else {
                        keyStatus = "The clipboard doesn't hold a key. Keys start with $KEY_PREFIX"
                    }
                }, small = true)
                SecondaryButton("Check key", { checks++ }, small = true)
            }
        }
        keyStatus?.let {
            Text(it, color = ToleranceColors.Muted, fontSize = 12.sp, modifier = Modifier.padding(top = 12.dp))
        }

        Spacer(Modifier.height(16.dp))
        PrimaryButton("Upgrade to Pro", {
            context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(CreditMonitor.ACCOUNT_URL)))
        })
        Text(
            "Hosted scoring with a much bigger allowance. After buying, copy the key from your account " +
                "page, choose Pro or Own Key here and tap Paste.",
            color = ToleranceColors.Faint, fontSize = 12.sp, modifier = Modifier.padding(top = 8.dp),
        )
    }
}

private const val KEY_PREFIX = "sk-or-"
private const val PREF_ASKED_NOTIFICATIONS = "asked_notifications"

private fun describeKey(check: OpenRouterClient.KeyCheck, freeTier: Boolean): String = when (check) {
    is OpenRouterClient.KeyCheck.Ok -> {
        val limit = check.limit
        val remaining = check.remaining
        when {
            limit == null || remaining == null -> "Key works. No spend limit set."
            remaining <= 0 -> if (freeTier) "Free credits used up for this month." else "Key works, but its credit is used up."
            else -> "Key works: \$%.2f of \$%.2f left%s.".format(remaining, limit, if (freeTier) " this month" else "")
        }
    }
    is OpenRouterClient.KeyCheck.Refused -> "OpenRouter refused this key (error ${check.status})."
    OpenRouterClient.KeyCheck.Failed -> "Couldn't reach OpenRouter to check the key."
}

@Composable
private fun TierOption(title: String, description: String, selected: Boolean, modifier: Modifier, onClick: () -> Unit) {
    val shape = RoundedCornerShape(8.dp)
    Column(
        modifier
            .clip(shape)
            .background(ToleranceColors.Field)
            .border(2.dp, if (selected) ToleranceColors.Toggle else ToleranceColors.FieldBorder, shape)
            .clickable(onClick = onClick)
            .padding(14.dp)
    ) {
        Text(title, color = ToleranceColors.Heading, fontWeight = FontWeight.Medium)
        Text(description, color = ToleranceColors.Muted, fontSize = 12.sp, modifier = Modifier.padding(top = 2.dp))
    }
}

// --- Shared pieces ---

@Composable
private fun FeatureToggleCard(title: String, description: String, checked: Boolean, onChange: (Boolean) -> Unit) {
    DashboardCard(title, feature = true, action = { DashboardSwitch(checked, onChange) }) {
        Text(description, color = ToleranceColors.Muted, fontSize = 13.sp, lineHeight = 19.sp)
    }
}

@Composable
private fun SettingRow(label: String, description: String?, control: @Composable () -> Unit) {
    Row(
        Modifier.fillMaxWidth().padding(vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Column(Modifier.weight(1f)) {
            Text(label, color = ToleranceColors.Text, fontSize = 14.sp)
            description?.let { Text(it, color = ToleranceColors.Faint, fontSize = 12.sp, modifier = Modifier.padding(top = 4.dp)) }
        }
        control()
    }
}

@Composable
private fun DashboardField(value: String, onChange: (String) -> Unit, placeholder: String, secret: Boolean = false) {
    OutlinedTextField(
        value = value,
        onValueChange = onChange,
        placeholder = { Text(placeholder, color = ToleranceColors.Faint, fontSize = 14.sp) },
        singleLine = true,
        visualTransformation = if (secret) PasswordVisualTransformation() else androidx.compose.ui.text.input.VisualTransformation.None,
        keyboardOptions = if (secret) KeyboardOptions(keyboardType = KeyboardType.Password) else KeyboardOptions.Default,
        shape = RoundedCornerShape(4.dp),
        colors = OutlinedTextFieldDefaults.colors(
            focusedContainerColor = ToleranceColors.Field,
            unfocusedContainerColor = ToleranceColors.Field,
            focusedBorderColor = ToleranceColors.Toggle,
            unfocusedBorderColor = ToleranceColors.FieldBorder,
            focusedTextColor = Color.White,
            unfocusedTextColor = Color.White,
        ),
        modifier = Modifier.fillMaxWidth(),
    )
}

@Composable
private fun MinutesField(label: String, value: String, onChange: (String) -> Unit) {
    Row(
        Modifier.fillMaxWidth().padding(top = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        Text(label, color = ToleranceColors.Muted, fontSize = 13.sp)
        OutlinedTextField(
            value = value,
            onValueChange = { if (it.all(Char::isDigit)) onChange(it) },
            singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
            shape = RoundedCornerShape(4.dp),
            colors = OutlinedTextFieldDefaults.colors(
                focusedContainerColor = ToleranceColors.Field,
                unfocusedContainerColor = ToleranceColors.Field,
                unfocusedBorderColor = ToleranceColors.FieldBorder,
            ),
            modifier = Modifier.width(88.dp),
        )
    }
}

private data class PlatformEntry(val key: String, val name: String, val note: String?)

private val PLATFORMS = listOf(
    PlatformEntry("twitter", "Twitter / X", null),
    PlatformEntry("tiktok", "TikTok", "For You only. Creators you follow and the Following tab are never covered."),
    PlatformEntry("youtube", "YouTube", null),
)

// The progress bar's last segment (Minimal) is drawn this long
private const val LAST_SEGMENT_MINUTES = 30.0
