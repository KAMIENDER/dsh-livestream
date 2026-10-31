using System.Globalization;
using System.Text.Json;
using StardewModdingAPI;
using StardewValley;
using StardewValley.Menus;

namespace DshStardew;

/// <summary>Passive, game-thread observations. Never construct/parse a shipping menu or recalculate prices.</summary>
internal sealed class NightObservation
{
    // Field layout and price/credit ordering were inspected in this exact local assembly.
    private const string SupportedBuild = "e2d77e0c-417e-41ec-b5ab-ab6e915ce317";
    internal sealed record Date(int Year, string Season, int DayOfMonth);
    internal sealed record Line(int Category, string ItemId, int Quality, int Quantity, int UnitPrice, int Total);
    internal sealed record Shipping(int[] CategoryTotals, Line[] Lines, int Total, string Digest);
    internal sealed record Receipt(string ObserverId, int Sequence, string RunId, string ClientId, string SaveId,
        string PlayerId, string GameBuildId, Date DateBefore, Date DateAfter, string MoneyAtDayEnding,
        string MoneyAtDayStarted, string NetChange, string Status, string? Reason, Shipping? Shipping);
    private sealed class Pending
    {
        public string RunId = "", ClientId = "", SaveId = "", PlayerId = "";
        public Date Before = new(0, "", 0);
        public string Money = "";
        public ShippingMenu? Menu;
        public Shipping? Shipping;
        public string? Failure;
    }

    private string observerId = Guid.NewGuid().ToString("D");
    private int sequence;
    private Pending? pending;
    private Receipt? latest;
    private static Date Today() => new(Game1.year, Game1.currentSeason, Game1.dayOfMonth);
    private static string Money() => Game1.player.Money.ToString(CultureInfo.InvariantCulture);
    private static int Day(Date d)
    {
        var season = Array.IndexOf(new[] { "spring", "summer", "fall", "winter" }, d.Season);
        if (season < 0 || d.Year < 1 || d.DayOfMonth is < 1 or > 28) throw new InvalidOperationException("night_date_unavailable");
        return checked(d.Year * 112 + season * 28 + d.DayOfMonth);
    }
    private static bool Supported() => Context.IsMainPlayer && !Context.IsMultiplayer
        && typeof(Game1).Assembly.ManifestModule.ModuleVersionId.ToString("D") == SupportedBuild;

    public void Clear()
    {
        observerId = Guid.NewGuid().ToString("D"); sequence = 0; pending = null; latest = null;
    }

    public void DayEnding(string? runId, string? clientId)
    {
        if (runId is null || clientId is null || !Supported()) return;
        try
        {
            if (pending is not null) { pending.Failure = "multiple_day_ending_events"; return; }
            if (sequence == int.MaxValue) { Clear(); return; }
            pending = new Pending { RunId = runId, ClientId = clientId, SaveId = GameFacts.SaveId(),
                PlayerId = Game1.player.UniqueMultiplayerID.ToString(CultureInfo.InvariantCulture), Before = Today(), Money = Money() };
            sequence++;
            if (Game1.activeClickableMenu is ShippingMenu) pending.Failure = "shipping_menu_preexisting_at_day_ending";
        }
        catch { pending = null; latest = null; /* Missing evidence never becomes an empty/zero shipment. */ }
    }

    public void ObserveMenu(IClickableMenu? menu)
    {
        var p = pending;
        if (p is null || p.Failure is not null || menu is not ShippingMenu) return;
        try
        {
            if (!Supported() || GameFacts.SaveId() != p.SaveId || Game1.player.UniqueMultiplayerID.ToString(CultureInfo.InvariantCulture) != p.PlayerId)
                throw new InvalidOperationException("night_identity_changed");
            if (!ReferenceEquals(menu, Game1.activeClickableMenu) || menu.GetType() != typeof(ShippingMenu) || menu.GetChildMenu() is not null)
                throw new InvalidOperationException("unsupported_shipping_menu");
            if (p.Menu is not null && !ReferenceEquals(p.Menu, menu)) throw new InvalidOperationException("multiple_shipping_menus");
            var captured = Capture((ShippingMenu)menu);
            if (p.Shipping is not null && p.Shipping.Digest != captured.Digest) throw new InvalidOperationException("shipping_cache_changed");
            p.Menu = (ShippingMenu)menu; p.Shipping = captured;
        }
        catch (Exception error) { p.Failure ??= error is InvalidOperationException ? error.Message : "shipping_cache_unavailable"; }
    }

    private static Shipping Capture(ShippingMenu menu)
    {
        // Read the normal menu's *already computed* caches. parseItems changes stacks,
        // stats and collections; sellToStorePrice can run mod code. Neither is called here.
        if (R.Get(menu, "categoryTotals") is not List<int> totals || totals.Count != 6
            || R.Get(menu, "categoryItems") is not List<List<Item>> categories || categories.Count != 6
            || R.Get(menu, "itemValues") is not Dictionary<Item, int> values
            || R.Get(menu, "singleItemValues") is not Dictionary<Item, int> units)
            throw new InvalidOperationException("shipping_cache_layout_unavailable");
        if (totals.Any(n => n < 0) || categories.Any(c => c is null || c.Count > 64)
            || categories[5].Count > 64 || values.Count > 64 || units.Count > 64)
            throw new InvalidOperationException("shipping_cache_exceeds_complete_bounds");
        var seen = new HashSet<Item>(ReferenceEqualityComparer.Instance);
        var lines = new List<Line>();
        for (var category = 0; category < 5; category++)
        {
            long sum = 0;
            foreach (var item in categories[category])
            {
                if (lines.Count >= 64 || item is not StardewValley.Object obj || item.GetType() != typeof(StardewValley.Object)
                    || !seen.Add(item) || obj.Stack is < 1 or > 10000 || obj.Quality is < 0 or > 4
                    || obj.QualifiedItemId.Length is < 1 or > 128
                    || !values.TryGetValue(item, out var total) || !units.TryGetValue(item, out var unit)
                    || unit < 0 || total < 0 || (long)unit * obj.Stack != total)
                    throw new InvalidOperationException("shipping_cache_item_unavailable");
                lines.Add(new Line(category, obj.QualifiedItemId, obj.Quality, obj.Stack, unit, total)); sum += total;
            }
            if (sum != totals[category]) throw new InvalidOperationException("shipping_category_total_mismatch");
        }
        var all = new HashSet<Item>(categories[5], ReferenceEqualityComparer.Instance);
        if (categories[5].Count != seen.Count || !all.SetEquals(seen) || values.Count != seen.Count || units.Count != seen.Count
            || totals.Take(5).Sum(n => (long)n) != totals[5]) throw new InvalidOperationException("shipping_cache_incomplete");
        var copiedTotals = totals.ToArray(); var copiedLines = lines.ToArray();
        return new Shipping(copiedTotals, copiedLines, totals[5], GameFacts.Hash(JsonSerializer.Serialize(new { copiedTotals, copiedLines }, LocalServer.Json)));
    }

    public void DayStarted()
    {
        var p = pending;
        if (p is null) return; // Save loading also raises DayStarted, which is not a completed night.
        try
        {
            if (!Supported() || GameFacts.SaveId() != p.SaveId || Game1.player.UniqueMultiplayerID.ToString(CultureInfo.InvariantCulture) != p.PlayerId
                || Day(Today()) != Day(p.Before) + 1) throw new InvalidOperationException("night_identity_or_date_changed");
            ObserveMenu(Game1.activeClickableMenu);
            var after = Money(); var reason = p.Failure ?? (p.Shipping is null ? "shipping_menu_not_observed" : null);
            latest = new Receipt(observerId, sequence, p.RunId, p.ClientId, p.SaveId, p.PlayerId, SupportedBuild, p.Before, Today(), p.Money,
                after, (long.Parse(after, CultureInfo.InvariantCulture) - long.Parse(p.Money, CultureInfo.InvariantCulture)).ToString(CultureInfo.InvariantCulture),
                reason is null ? "observed" : "unavailable", reason, reason is null ? p.Shipping : null);
        }
        catch { latest = null; }
        finally { pending = null; }
    }

    public object Query(JsonElement args, string runId, string clientId)
    {
        var expected = R.Arg(args, "observerId");
        var after = args.TryGetProperty("afterSequence", out var value) && value.TryGetInt32(out var n) && n >= 0 ? n : (int?)null;
        if (args.EnumerateObject().Any(p => p.Name is not "observerId" and not "afterSequence")
            || (expected.Length > 0) != after.HasValue || args.TryGetProperty("afterSequence", out _) && !after.HasValue)
            throw new ArgumentException("night_cursor_requires_observer_and_nonnegative_sequence");
        var matched = expected.Length == 0 || expected == observerId;
        var receipt = matched && latest is { } r && r.RunId == runId && r.ClientId == clientId && (after is null || r.Sequence > after) ? latest : null;
        return new { cursor = new { observerId, sequence }, cursorMatched = matched, supportedBuild = Supported(), receipt,
            pending = pending is { } p && p.RunId == runId && p.ClientId == clientId,
            note = "Read-only native cache observation. Shipping total is not a causal proof of wallet credit; net change is separate. Missing menu is unknown, never zero. No durable native history." };
    }
}
