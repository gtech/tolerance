package lol.tolerance.android.ui.theme

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import lol.tolerance.android.boredom.ProgressiveBoredomTracker.Phase

/**
 * The extension dashboard's look (extension/src/dashboard/index.html): near-black page,
 * #141414 cards with a hairline border, small uppercase gray card titles, purple primary
 * buttons and indigo-to-violet toggles. Always dark, like the dashboard.
 */
object ToleranceColors {
    val Page = Color(0xFF0A0A0A)
    val Card = Color(0xFF141414)
    val Hairline = Color(0xFF222222)
    val Field = Color(0xFF222222)
    val FieldBorder = Color(0xFF333333)
    val Text = Color(0xFFE0E0E0)
    val Heading = Color.White
    val Muted = Color(0xFF888888)
    val Faint = Color(0xFF666666)
    val PrimaryButton = Color(0xFF3D2D4A)
    val PrimaryButtonText = Color(0xFFB07DCE)
    val Toggle = Color(0xFF667EEA)
    val ToggleEnd = Color(0xFF764BA2)
    val ToggleOff = Color(0xFF333333)
    val FeatureBorder = Color(0xFF4A4A8A)
    val FeatureBrush = Brush.linearGradient(listOf(Color(0xFF1A1A2E), Color(0xFF16213E)))
    val Link = Color(0xFF4A9EFF)

    /** Phase badge colors: (background, text). */
    fun phase(phase: Phase): Pair<Color, Color> = when (phase) {
        Phase.NORMAL -> Color(0xFF1A472A) to Color(0xFF4CAF50)
        Phase.REDUCED -> Color(0xFF3D3D1A) to Color(0xFFFFC107)
        Phase.WIND_DOWN -> Color(0xFF4A2D1A) to Color(0xFFFF9800)
        Phase.MINIMAL -> Color(0xFF4A1A1A) to Color(0xFFF44336)
    }
}

private val DashboardColors = darkColorScheme(
    primary = ToleranceColors.Toggle,
    onPrimary = Color.White,
    primaryContainer = ToleranceColors.PrimaryButton,
    onPrimaryContainer = ToleranceColors.PrimaryButtonText,
    secondary = ToleranceColors.Muted,
    onSecondary = Color.White,
    secondaryContainer = ToleranceColors.Field,
    onSecondaryContainer = ToleranceColors.Muted,
    background = ToleranceColors.Page,
    onBackground = ToleranceColors.Text,
    surface = ToleranceColors.Page,
    onSurface = ToleranceColors.Text,
    surfaceVariant = ToleranceColors.Field,
    onSurfaceVariant = ToleranceColors.Muted,
    outline = ToleranceColors.FieldBorder,
    outlineVariant = ToleranceColors.Hairline,
)

@Composable
fun ToleranceTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = DashboardColors, content = content)
}

/** A dashboard card. [feature] gives it the gradient and indigo border of the toggle cards. */
@Composable
fun DashboardCard(
    title: String,
    modifier: Modifier = Modifier,
    feature: Boolean = false,
    action: (@Composable () -> Unit)? = null,
    content: @Composable ColumnScope.() -> Unit,
) {
    val shape = RoundedCornerShape(12.dp)
    val surface = if (feature) Modifier.background(ToleranceColors.FeatureBrush, shape)
    else Modifier.background(ToleranceColors.Card, shape)
    Column(
        modifier
            .fillMaxWidth()
            .then(surface)
            .border(BorderStroke(1.dp, if (feature) ToleranceColors.FeatureBorder else ToleranceColors.Hairline), shape)
            .padding(20.dp)
    ) {
        Row(
            Modifier.fillMaxWidth().padding(bottom = 16.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            CardTitle(title)
            action?.invoke()
        }
        content()
    }
}

@Composable
fun CardTitle(text: String) {
    Text(
        text.uppercase(),
        color = ToleranceColors.Muted,
        fontSize = 14.sp,
        fontWeight = FontWeight.Medium,
        letterSpacing = 0.5.sp,
    )
}

/** The dashboard's toggle: indigo track when on, white thumb. */
@Composable
fun DashboardSwitch(checked: Boolean, onCheckedChange: (Boolean) -> Unit) {
    Switch(
        checked = checked,
        onCheckedChange = onCheckedChange,
        colors = SwitchDefaults.colors(
            checkedThumbColor = Color.White,
            checkedTrackColor = ToleranceColors.Toggle,
            checkedBorderColor = ToleranceColors.Toggle,
            uncheckedThumbColor = ToleranceColors.Muted,
            uncheckedTrackColor = ToleranceColors.ToggleOff,
            uncheckedBorderColor = ToleranceColors.ToggleOff,
        ),
    )
}

@Composable
fun PrimaryButton(text: String, onClick: () -> Unit, modifier: Modifier = Modifier) {
    Button(
        onClick = onClick,
        modifier = modifier,
        shape = RoundedCornerShape(6.dp),
        colors = ButtonDefaults.buttonColors(
            containerColor = ToleranceColors.PrimaryButton,
            contentColor = ToleranceColors.PrimaryButtonText,
        ),
    ) { Text(text) }
}

@Composable
fun SecondaryButton(text: String, onClick: () -> Unit, modifier: Modifier = Modifier, small: Boolean = false) {
    Button(
        onClick = onClick,
        modifier = modifier,
        shape = RoundedCornerShape(6.dp),
        contentPadding = if (small) PaddingValuesSmall else ButtonDefaults.ContentPadding,
        colors = ButtonDefaults.buttonColors(
            containerColor = ToleranceColors.Field,
            contentColor = ToleranceColors.Muted,
        ),
    ) { Text(text, fontSize = if (small) 12.sp else 14.sp) }
}

private val PaddingValuesSmall = PaddingValues(horizontal = 10.dp, vertical = 4.dp)
