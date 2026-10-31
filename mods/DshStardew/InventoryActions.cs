using System.Text.Json;
using StardewModdingAPI;
using StardewValley;
using StardewValley.Tools;

namespace DshStardew;

internal sealed class PreconditionRejectedException : InvalidOperationException
{
    public PreconditionRejectedException(string message) : base(message) { }
}

/// <summary>Conserving native inventory operations; no save editing or item grants.</summary>
internal static class InventoryActions
{
    internal sealed record Count(string ItemId, int Quality, long Amount);
    public static string Digest() => GameFacts.Hash(JsonSerializer.Serialize(GameFacts.Inventory(), LocalServer.Json));
    public static Count[] Counts() => Game1.player.Items.Where(item => item is not null)
        .GroupBy(item => (item.QualifiedItemId, item.Quality)).Select(group => new Count(group.Key.QualifiedItemId, group.Key.Quality, group.Sum(item => (long)item.Stack))).ToArray();
    public static Count[] Changes(Count[] before) => Counts().Select(now => new Count(now.ItemId, now.Quality,
        now.Amount - (before.FirstOrDefault(old => old.ItemId == now.ItemId && old.Quality == now.Quality)?.Amount ?? 0)))
        .Concat(before.Where(old => !Game1.player.Items.Any(item => item is not null && item.QualifiedItemId == old.ItemId && item.Quality == old.Quality)).Select(old => old with { Amount = -old.Amount }))
        .Where(change => change.Amount != 0).ToArray();
    public static object Capture() => new {
        digest = Digest(), selectedSlot = Game1.player.CurrentToolIndex,
        slots = Game1.player.Items.Select((item, index) => new { index,
            item = item is null ? null : new { qualifiedItemId = item.QualifiedItemId, stack = item.Stack, quality = item.Quality,
                toolClassName = item is Tool ? item.GetType().Name : null } }).ToArray(),
    };
    public static void Require(bool condition, string message) { if (!condition) throw new PreconditionRejectedException(message); }

    public static object Split(JsonElement args)
    {
        Require(Context.CanPlayerMove && Game1.activeClickableMenu is null && !Game1.eventUp && !Game1.player.UsingTool, "Close native menus and finish the current action before splitting stacks");
        Require(R.Arg(args, "digest") == Digest(), "stale_inventory: query current inventory again");
        var from = R.Int(args, "sourceSlot", -1, 0, Game1.player.Items.Count - 1);
        var to = R.Int(args, "destinationSlot", -1, 0, Game1.player.Items.Count - 1);
        var count = R.Int(args, "quantity", 0, 1, 10000);
        var source = Game1.player.Items[from];
        Require(from != to && source is not null && Game1.player.Items[to] is null, "Split needs an occupied source and an actual empty destination");
        Require(source!.QualifiedItemId == R.Arg(args, "expectedItemId") && source.Quality == R.Int(args, "expectedQuality", -1, 0, 4), "Source item or quality changed");
        Require(source.Stack > count && source is not Tool, "Split must leave a positive source stack; tools cannot be split");
        var before = Capture(); var totals = Counts(); var total = source.Stack;
        // getOne() is the native clone used for ordinary inventory splitting. Total quantity
        // stays constant, and the original item retains its remaining native state.
        var portion = source.getOne();
        Require(portion is not null && !ReferenceEquals(portion, source) && portion.QualifiedItemId == source.QualifiedItemId && portion.Quality == source.Quality, "Native item clone did not preserve distinct item identity");
        if (R.Arg(args, "digest") != Digest()) throw new InvalidOperationException("Inventory changed during native item cloning; split was not committed");
        portion!.Stack = count; source.Stack = total - count; Game1.player.Items[to] = portion;
        var confirmed = ReferenceEquals(Game1.player.Items[from], source) && ReferenceEquals(Game1.player.Items[to], portion)
            && source.Stack == total - count && portion.Stack == count && Changes(totals).Length == 0;
        return new { completedWorkflow = confirmed, completionUncertain = !confirmed, operation = "split_stack", before, after = Capture(),
            sourceSlot = from, destinationSlot = to, quantity = count, conservedTotal = confirmed ? total : (int?)null };
    }
}
