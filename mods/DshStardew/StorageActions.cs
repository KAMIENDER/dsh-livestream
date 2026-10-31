using System.Runtime.CompilerServices;
using System.Text.Json;
using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewValley;
using StardewValley.Menus;
using StardewValley.Objects;

namespace DshStardew;

/// <summary>Audited ordinary storage identity and native open/close only.
/// Actual transfers reuse the existing MCP conserving planner/committer.</summary>
internal static class StorageActions
{
    private sealed class Token { public readonly string Value = Guid.NewGuid().ToString("N"); }
    private static readonly ConditionalWeakTable<object, Token> Tokens = new();
    private static string Ref(object value) => Tokens.GetValue(value, _ => new Token()).Value;
    private static bool SupportedBuild => typeof(Farmer).Assembly.ManifestModule.ModuleVersionId == new Guid("e2d77e0c-417e-41ec-b5ab-ab6e915ce317");
    internal sealed record Target(Chest Chest, int X, int Y, bool MainFridge)
    {
        public object Position => new { locationId = Game1.currentLocation.NameOrUniqueName, x = X, y = Y };
        public string Key => Ref(Chest);
        public string Kind => MainFridge || Chest.fridge.Value ? "fridge" : Chest.SpecialChestType == StardewValley.Objects.Chest.SpecialChestTypes.BigChest ? "big_chest" : "chest";
    }
    internal sealed class Attempt
    {
        public Target Target = null!;
        public string Operation = "", Revision = "";
        public int InteractionSlot = -1, Gold;
        public ItemGrabMenu? Menu;
        public WorldInteraction? World;
        public bool Submitted, NativeAccepted;
        public InventoryActions.Count[] BeforePlayer = Array.Empty<InventoryActions.Count>(), BeforeContainer = Array.Empty<InventoryActions.Count>();
    }
    private static bool Compatible(Target target) => target.Chest.GetType() == typeof(Chest)
        && target.Chest.GlobalInventoryId is null && (target.Chest.SpecialChestType is Chest.SpecialChestTypes.None or Chest.SpecialChestTypes.BigChest)
        && (target.MainFridge || target.Chest.playerChest.Value && !target.Chest.fridge.Value)
        && target.Chest.GetActualCapacity() is > 0 and <= 128 && target.Chest.Items.Count <= target.Chest.GetActualCapacity();
    private static int? Capacity(Target target) => target.Chest.GetType() == typeof(Chest) ? target.Chest.GetActualCapacity() : null;
    private static Target? At(int x, int y)
    {
        var location = Game1.currentLocation;
        if (location.GetFridgePosition() is { } fridgePosition && fridgePosition.X == x && fridgePosition.Y == y
            && location.GetFridge(false) is { } fridge && ReferenceEquals(location.GetFridge(), fridge)) return new Target(fridge, x, y, true);
        return location.Objects.TryGetValue(new Vector2(x, y), out var item) && item is Chest chest ? new Target(chest, x, y, false) : null;
    }
    private static Target? FromArgs(JsonElement args)
    {
        InventoryActions.Require(args.TryGetProperty("position", out var p) && R.Arg(p, "locationId") == Game1.currentLocation.NameOrUniqueName, "Storage position must be in the actual current location");
        var x = R.Int(p, "x", -1, 0, 10000); var y = R.Int(p, "y", -1, 0, 10000); var layer = Game1.currentLocation.Map.Layers[0];
        InventoryActions.Require(x < layer.LayerWidth && y < layer.LayerHeight, "Storage position is outside the current map");
        return At(x, y);
    }
    private static InventoryActions.Count[] ContainerCounts(Target target) => target.Chest.Items.Where(item => item is not null)
        .GroupBy(item => (item.QualifiedItemId, item.Quality)).Select(group => new InventoryActions.Count(group.Key.QualifiedItemId, group.Key.Quality, group.Sum(item => (long)item.Stack)))
        .OrderBy(row => row.ItemId, StringComparer.Ordinal).ThenBy(row => row.Quality).ToArray();
    private static string Digest(Target target) => GameFacts.Hash(JsonSerializer.Serialize(new {
        targetKey = target.Key, target.Position, target.Kind, target.MainFridge, target.Chest.QualifiedItemId,
        type = target.Chest.GetType().FullName, target.Chest.GlobalInventoryId, target.Chest.SpecialChestType,
        fridge = target.Chest.fridge.Value, playerChest = target.Chest.playerChest.Value, capacity = Capacity(target),
    }, LocalServer.Json));
    private static bool ActorBlocked(Target target)
    {
        var tile = new Rectangle(target.X * 64, target.Y * 64, 64, 64);
        return Game1.currentLocation.characters.Any(character => character.GetBoundingBox().Intersects(tile))
            || AnimalCare.In(Game1.currentLocation).Any(animal => animal.GetBoundingBox().Intersects(tile));
    }
    private static object Fact(Target target) => new {
        target.Position, targetKey = target.Key, targetDigest = Digest(target), target.Kind, itemId = target.Chest.QualifiedItemId,
        mainFridge = target.MainFridge, compatibleWithAuditedMcp = Compatible(target), capacity = Capacity(target),
        adjacent = Math.Abs(Game1.player.Tile.X - target.X) + Math.Abs(Game1.player.Tile.Y - target.Y) == 1, actorBlocked = ActorBlocked(target),
        // Do not call GetItemsForPlayer/GetOrCreate for a read. This adapter only
        // transfers local ordinary inventories; global/separate/Junimo stores are not substituted.
        contents = Compatible(target) ? ContainerCounts(target) : null,
        note = Compatible(target) ? "Audited ordinary chest/big chest or unlocked main fridge; actual MCP UI projection must still be complete."
            : "This target requires another storage adapter; mini-fridges, shared/Junimo, hoppers, shipping and custom chest classes are not ordinary MCP storage.",
    };
    private static (ItemGrabMenu Menu, Target Target)? Current()
    {
        if (Game1.activeClickableMenu?.GetType() != typeof(ItemGrabMenu) || Game1.activeClickableMenu.GetChildMenu() is not null) return null;
        var menu = (ItemGrabMenu)Game1.activeClickableMenu;
        if (menu.source != ItemGrabMenu.source_chest || menu.shippingBin || menu.reverseGrab || !menu.showReceivingMenu || menu.destroyItemOnClick || menu.context is not Chest chest) return null;
        Target? target = null;
        if (Game1.currentLocation.GetFridgePosition() is { } position && ReferenceEquals(Game1.currentLocation.GetFridge(false), chest)
            && ReferenceEquals(Game1.currentLocation.GetFridge(), chest) && menu.sourceItem is null) target = new Target(chest, position.X, position.Y, true);
        else foreach (var pair in Game1.currentLocation.Objects.Pairs)
            if (ReferenceEquals(pair.Value, chest) && ReferenceEquals(menu.sourceItem, chest)) { target = new Target(chest, (int)pair.Key.X, (int)pair.Key.Y, false); break; }
        return target is not null && Compatible(target) ? (menu, target) : null;
    }
    private static object? Held(ItemGrabMenu? menu) => menu?.heldItem is { } item ? new { itemId = item.QualifiedItemId, quality = item.Quality, count = item.Stack } : null;
    private static string Revision(Target? selected) => GameFacts.Hash(JsonSerializer.Serialize(new {
        save = GameFacts.SaveId(), date = GameFacts.DayKey(), location = Game1.currentLocation.NameOrUniqueName,
        tile = R.Plain(Game1.player.Tile), inventoryDigest = InventoryActions.Digest(), gold = Game1.player.Money,
        menu = Game1.activeClickableMenu is { } root ? Ref(root) : null,
        target = selected is null ? null : Fact(selected), current = Current() is { } current ? new {
            menuId = Ref(current.Menu), targetKey = current.Target.Key, held = Held(current.Menu), locked = current.Target.Chest.GetMutex().IsLockHeld(),
        } : null,
    }, LocalServer.Json));
    public static object Query(JsonElement args)
    {
        Target? selected = args.TryGetProperty("position", out _) ? FromArgs(args) : null;
        var current = Current(); var targets = new List<Target>();
        if (selected is not null) targets.Add(selected);
        else if (!args.TryGetProperty("position", out _))
        {
            foreach (var pair in Game1.currentLocation.Objects.Pairs)
                if (pair.Value is Chest chest && Math.Abs(Game1.player.Tile.X - pair.Key.X) + Math.Abs(Game1.player.Tile.Y - pair.Key.Y) <= 12)
                    targets.Add(new Target(chest, (int)pair.Key.X, (int)pair.Key.Y, false));
            if (Game1.currentLocation.GetFridgePosition() is { } p && At(p.X, p.Y) is { MainFridge: true } fridge
                && Math.Abs(Game1.player.Tile.X - p.X) + Math.Abs(Game1.player.Tile.Y - p.Y) <= 12) targets.Add(fridge);
        }
        var offset = R.Int(args, "offset", 0, 0, 100000); var limit = R.Int(args, "limit", 20, 1, 100);
        return new { supportedBuild = SupportedBuild, revision = Revision(selected), selectedTargetKey = selected?.Key,
            items = targets.OrderBy(target => target.Y).ThenBy(target => target.X).Skip(offset).Take(limit).Select(Fact).ToArray(),
            count = targets.Count, offset, nextOffset = offset + limit < targets.Count ? (int?)(offset + limit) : null,
            menuType = Game1.activeClickableMenu?.GetType().FullName, player = InventoryActions.Counts(), gold = Game1.player.Money,
            current = current is null ? null : new { menuId = Ref(current.Value.Menu), target = Fact(current.Value.Target), held = Held(current.Value.Menu),
                lockHeld = current.Value.Target.Chest.GetMutex().IsLockHeld(), sourceInventoryId = Ref(current.Value.Target.Chest.Items),
                backingMatches = ReferenceEquals(current.Value.Menu.ItemsToGrabMenu.actualInventory, current.Value.Target.Chest.Items)
                    && ReferenceEquals(current.Value.Menu.inventory.actualInventory, Game1.player.Items) },
            note = "Native identity/quantities only. Transfer uses real MCP UI links and both inventory revisions. Query does not create shared backing stores or infer missing targets as empty inventories." };
    }
    internal static Attempt Prepare(JsonElement args)
    {
        InventoryActions.Require(SupportedBuild && !Game1.eventUp && !Game1.fadeToBlack && R.Get(typeof(Game1), "currentMinigame") is null && Game1.player.health > 0, "Native storage context is unavailable");
        var target = FromArgs(args);
        InventoryActions.Require(target is not null && Compatible(target) && target.Key == R.Arg(args, "targetKey") && Digest(target) == R.Arg(args, "targetDigest"), "The exact audited storage instance changed");
        InventoryActions.Require(R.Arg(args, "revision") == Revision(target), "Storage/player/menu changed; requery before action");
        var attempt = new Attempt { Target = target!, Operation = R.Arg(args, "operation"), Revision = Revision(target), Gold = Game1.player.Money,
            BeforePlayer = InventoryActions.Counts(), BeforeContainer = ContainerCounts(target!) };
        if (attempt.Operation == "open")
        {
            InventoryActions.Require(Game1.activeClickableMenu is null && Context.CanPlayerMove && !Game1.player.UsingTool
                && Math.Abs(Game1.player.Tile.X - target!.X) + Math.Abs(Game1.player.Tile.Y - target.Y) == 1 && !ActorBlocked(target), "Stand adjacent to the unobstructed actual storage in the idle world");
            attempt.InteractionSlot = Enumerable.Range(0, Game1.player.Items.Count).FirstOrDefault(index => Game1.player.Items[index] is null || Game1.player.Items[index] is Tool, -1);
            InventoryActions.Require(attempt.InteractionSlot >= 0, "No empty/tool slot for normal storage interaction");
        }
        else
        {
            var current = Current();
            InventoryActions.Require(attempt.Operation == "close" && current is not null && ReferenceEquals(current.Value.Target.Chest, target!.Chest)
                && current.Value.Menu.heldItem is null && current.Value.Menu.readyToClose() && target.Chest.GetMutex().IsLockHeld(), "Only close this exact locked storage with an empty cursor");
            attempt.Menu = current!.Value.Menu;
        }
        return attempt;
    }
    internal static bool ContextMatches(Attempt attempt) => ReferenceEquals(At(attempt.Target.X, attempt.Target.Y)?.Chest, attempt.Target.Chest)
        && Compatible(attempt.Target) && Revision(attempt.Target) == attempt.Revision;
    internal static void Execute(Attempt attempt)
    {
        InventoryActions.Require(ContextMatches(attempt), "Storage changed before the native handler");
        attempt.Submitted = true;
        if (attempt.Operation == "close") { attempt.Menu!.exitThisMenu(); return; }
        attempt.World = WorldInteraction.Begin(attempt.Target.X, attempt.Target.Y, attempt.InteractionSlot);
        attempt.Revision = Revision(attempt.Target); attempt.NativeAccepted = true;
    }
    internal static bool Waiting(Attempt attempt) => attempt.Operation == "open" && attempt.NativeAccepted && Game1.activeClickableMenu is null;
    internal static object Finish(Attempt attempt)
    {
        var current = Current(); var player = InventoryActions.Counts(); var container = ContainerCounts(attempt.Target);
        var sameContents = JsonSerializer.Serialize(attempt.BeforePlayer, LocalServer.Json) == JsonSerializer.Serialize(player, LocalServer.Json)
            && JsonSerializer.Serialize(attempt.BeforeContainer, LocalServer.Json) == JsonSerializer.Serialize(container, LocalServer.Json) && attempt.Gold == Game1.player.Money;
        var attached = ReferenceEquals(At(attempt.Target.X, attempt.Target.Y)?.Chest, attempt.Target.Chest);
        var confirmed = sameContents && attached && (attempt.Operation == "close" ? Game1.activeClickableMenu is null
            : current is not null && ReferenceEquals(current.Value.Target.Chest, attempt.Target.Chest) && current.Value.Menu.heldItem is null && attempt.Target.Chest.GetMutex().IsLockHeld());
        return new { operation = attempt.Operation, completedWorkflow = confirmed, completionUncertain = !confirmed && attempt.Submitted,
            nativeActionSubmitted = attempt.Submitted, targetKey = attempt.Target.Key, target = Fact(attempt.Target),
            beforePlayer = attempt.BeforePlayer, afterPlayer = player, beforeContainer = attempt.BeforeContainer, afterContainer = container,
            beforeGold = attempt.Gold, afterGold = Game1.player.Money, menuId = current is null ? null : Ref(current.Value.Menu),
            note = "Normal storage UI only; no item transfer, shipping, trash, automatic deposit or manual mutex release. Unknown/cancelled native lock callbacks are not replayed." };
    }
}
