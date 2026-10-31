using System.Text.Json;
using StardewModdingAPI;
using StardewValley;
using StardewValley.Menus;
using StardewValley.Tools;

namespace DshStardew;

internal sealed partial class ControlLoop
{
    private sealed class FishingAttempt
    {
        public InventoryActions.Count[] BeforeItems = Array.Empty<InventoryActions.Count>();
        public FishingActions.Attachment[] BeforeGear = Array.Empty<FishingActions.Attachment>();
        public int RodSlot;
        public int MaxBait;
        public int MaxWear;
        public float CastPower;
        public bool TryTreasure;
        public bool SawWater;
        public bool SawNibble;
        public bool SawTreasure;
        public string? CaughtId;
        public int CaughtQuality;
        public int CaughtCount;
        public List<object> MenuReceipts = new();
    }

    private void PrepareFishing(Job current, JsonElement args)
    {
        InventoryActions.Require(Game1.player.Stamina >= 30 && Game1.player.health >= current.HealthFloor && Game1.timeOfDay < 2200, "Retain energy, health and time for a bounded fishing attempt");
        InventoryActions.Require(R.Arg(args, "inventoryDigest") == InventoryActions.Digest(), "stale_inventory: query fishing and inventory again");
        var slot = R.Int(args, "rodSlot", -1, 0, Game1.player.Items.Count - 1);
        var rod = FishingActions.Rod(slot, R.Arg(args, "expectedRodItemId"));
        InventoryActions.Require(!rod.inUse() && !rod.showingTreasure && R.Arg(args, "gearDigest") == FishingActions.GearDigest(rod), "stale_gear: query idle rod again");
        var bait = R.Int(args, "maxBaitConsumed", 1, 0, 1); var wear = R.Int(args, "maxTackleWear", 1, 0, 1);
        var gear = FishingActions.Attachments(rod);
        InventoryActions.Require(args.TryGetProperty("expectedGear", out var expected) && expected.ValueKind == JsonValueKind.Array && expected.GetArrayLength() == gear.Length,
            "Provide the complete actual attachment identity list, including empty slots");
        var expectedRows = expected.EnumerateArray().ToArray();
        for (var i = 0; i < gear.Length; i++)
        {
            var row = expectedRows[i];
            InventoryActions.Require(R.Int(row, "index", -1, 0, 2) == i && row.TryGetProperty("itemId", out var id)
                && (gear[i].ItemId is null ? id.ValueKind == JsonValueKind.Null : id.ValueKind == JsonValueKind.String && id.GetString() == gear[i].ItemId)
                && R.Int(row, "quality", -1, 0, 4) == gear[i].Quality, "Attached bait/tackle identity or quality differs from the authorized request");
        }
        InventoryActions.Require((bait > 0 || !gear.Any(g => g.Index == 0 && g.ItemId is not null)) && (wear > 0 || !gear.Any(g => g.Index > 0 && g.ItemId is not null)), "A zero budget cannot start with consumable bait/tackle attached");
        InventoryActions.Require(Game1.currentLocation.canFishHere(), "Native location rules reject fishing here");
        InventoryActions.Require(args.TryGetProperty("position", out var p) && R.Arg(p, "locationId") == Game1.currentLocation.NameOrUniqueName
            && R.Int(p, "x", -1, 0, 10000) == (int)Game1.player.Tile.X && R.Int(p, "y", -1, 0, 10000) == (int)Game1.player.Tile.Y,
            "Standing position changed; query the fishing spot again");
        var direction = R.Int(args, "direction", Game1.player.FacingDirection, 0, 3);
        var delta = direction switch { 0 => new Microsoft.Xna.Framework.Point(0, -1), 1 => new Microsoft.Xna.Framework.Point(1, 0), 2 => new Microsoft.Xna.Framework.Point(0, 1), _ => new Microsoft.Xna.Framework.Point(-1, 0) };
        var origin = Game1.player.Tile; var layer = Game1.currentLocation.Map.Layers[0];
        InventoryActions.Require(Enumerable.Range(1, 12).Any(distance => {
            var x = (int)origin.X + delta.X * distance; var y = (int)origin.Y + delta.Y * distance;
            return x >= 0 && y >= 0 && x < layer.LayerWidth && y < layer.LayerHeight && Game1.currentLocation.isTileFishable(x, y);
        }), "No native fishable tile was observed on this bounded direction ray; no cast submitted");
        var treasure = !args.TryGetProperty("tryTreasure", out var t) || t.GetBoolean();
        current.Tool = rod;
        current.Fishing = new FishingAttempt { RodSlot = slot, BeforeItems = InventoryActions.Counts(), BeforeGear = gear, MaxBait = bait, MaxWear = wear,
            CastPower = R.Int(args, "castPowerPercent", 75, 10, 100) / 100f, TryTreasure = treasure };
    }

    private void TickFishing(Job current)
    {
        var rod = (FishingRod)current.Tool!; var attempt = current.Fishing!;
        attempt.SawWater |= rod.isFishing;
        attempt.SawNibble |= rod.isNibbling;
        attempt.SawTreasure |= rod.treasureCaught;
        current.SawCaught |= rod.fishCaught;
        if (rod.fishCaught && attempt.CaughtId is null)
        {
            attempt.CaughtId = R.Text(rod, "whichFish"); attempt.CaughtQuality = rod.fishQuality; attempt.CaughtCount = rod.numberOfFishCaught;
        }
        if (Game1.activeClickableMenu is { } menu)
        {
            if (menu is ItemGrabMenu grab && ReferenceEquals(grab.context, rod)) { CollectFishingMenu(current, grab); return; }
            if (menu is not BobberBar) { Finish("unrelated_menu"); return; }
            current.SawMinigame = true;
            // BobberBar.receiveLeftClick is empty in this build. Use one-tick native input;
            // every bar/treasure field below is feedback only, never a forced success value.
            var target = R.Number(menu, "bobberPosition");
            if (attempt.TryTreasure && R.Bool(menu, "treasure") && !R.Bool(menu, "treasureCaught")
                && R.Number(menu, "treasureAppearTimer") <= 0 && R.Number(menu, "treasureScale") >= .9 && R.Number(menu, "distanceFromCatching") > .65)
                target = R.Number(menu, "treasurePosition");
            var center = R.Number(menu, "bobberBarPos") + R.Number(menu, "bobberBarHeight") / 2;
            var speed = R.Number(menu, "bobberBarSpeed");
            if (!R.Bool(menu, "fadeOut") && target < center + speed * 4 - 3) Press("use_tool");
            return;
        }
        if (Game1.eventUp) { Finish("event_started"); return; }
        if (current.Stage == "charging")
        {
            if (!rod.isTimingCast)
            {
                if (rod.isCasting || rod.isFishing || rod.castedButBobberStillInAir) current.Stage = "fishing";
                else if (current.Ticks < 120) Press("use_tool");
                else Finish("cast_not_started");
                return;
            }
            if (rod.castingPower < attempt.CastPower) Press("use_tool");
            else
            {
                if (Game1.player.UsingTool && Game1.player.canReleaseTool) Game1.player.EndUsingTool();
                current.Stage = "fishing";
            }
            return;
        }
        // inUse() excludes the treasure-opening animation. Ending on inUse alone would
        // report completion before its native ItemGrabMenu was created and collected.
        if (current.Ticks > 20 && !rod.inUse() && !Game1.player.UsingTool && !rod.showingTreasure
            && !rod.pullingOutOfWater && !rod.castedButBobberStillInAir && rod.animations.Count == 0 && Context.CanPlayerMove)
        {
            FinishFishing(current); return;
        }
        var needsPress = rod.isNibbling || rod.fishCaught;
        if (needsPress && !current.LastPressed) { Press("use_tool"); current.LastPressed = true; }
        else current.LastPressed = false;
    }

    private void CollectFishingMenu(Job current, ItemGrabMenu menu)
    {
        var attempt = current.Fishing!;
        if (menu.heldItem is not null || menu.reverseGrab) { Finish("fishing_menu_changed"); return; }
        var items = menu.ItemsToGrabMenu.actualInventory;
        if (items.All(item => item is null))
        {
            if (menu.readyToClose()) menu.exitThisMenu(false);
            return;
        }
        foreach (var component in menu.ItemsToGrabMenu.inventory)
        {
            if (!int.TryParse(component.name, out var index) || index < 0 || index >= items.Count || items[index] is not { } item) continue;
            if (!Game1.player.couldInventoryAcceptThisItem(item)) continue;
            var id = item.QualifiedItemId; var quality = item.Quality; var count = item.Stack;
            var before = InventoryActions.Counts().FirstOrDefault(row => row.ItemId == id && row.Quality == quality)?.Amount ?? 0;
            // A real click on the currently visible source slot executes the native transfer
            // and its callbacks. No direct removal, reconstruction, discard or auto-sell.
            menu.receiveLeftClick(component.bounds.Center.X, component.bounds.Center.Y, false);
            var after = InventoryActions.Counts().FirstOrDefault(row => row.ItemId == id && row.Quality == quality)?.Amount ?? 0;
            var confirmed = count > 0 && after - before == count && menu.heldItem is null && !items.Any(left => ReferenceEquals(left, item));
            attempt.MenuReceipts.Add(new { itemId = id, quality, count, before, after, confirmed });
            if (!confirmed) Finish("fishing_menu_transfer_unconfirmed");
            return; // At most one native menu action per game tick.
        }
        Finish("inventory_full_or_unseen_fishing_items"); // Leave the native menu and remaining items intact.
    }

    private object FishingEvidence(Job current)
    {
        var attempt = current.Fishing!;
        return new { attempt.RodSlot, attempt.SawWater, attempt.SawNibble, attempt.SawTreasure,
            caught = new { itemId = attempt.CaughtId, quality = attempt.CaughtQuality, count = attempt.CaughtCount },
            beforeItems = attempt.BeforeItems, inventoryChanges = Context.IsWorldReady ? InventoryActions.Changes(attempt.BeforeItems) : null,
            beforeGear = attempt.BeforeGear, afterGear = Context.IsWorldReady ? FishingActions.Attachments((FishingRod)current.Tool!) : null,
            menuReceipts = attempt.MenuReceipts, maxBaitConsumed = attempt.MaxBait, maxTackleWear = attempt.MaxWear };
    }

    private void FinishFishing(Job current)
    {
        var attempt = current.Fishing!; var rod = (FishingRod)current.Tool!;
        var changes = InventoryActions.Changes(attempt.BeforeItems); var gains = changes.Where(row => row.Amount > 0).ToArray();
        var afterGear = FishingActions.Attachments(rod); var baitUsed = 0; var wear = new List<object>(); var budgetConfirmed = true;
        if (afterGear.Length != attempt.BeforeGear.Length) budgetConfirmed = false;
        if (attempt.BeforeGear.Any(before => before.ItemId is null && afterGear.Any(after => after.Index == before.Index && after.ItemId is not null))
            || changes.Any(change => change.Amount < 0)) budgetConfirmed = false;
        foreach (var before in attempt.BeforeGear.Where(g => g.ItemId is not null))
        {
            var after = afterGear.FirstOrDefault(g => g.Index == before.Index);
            if (after is null) { budgetConfirmed = false; continue; }
            if (before.Index == 0)
            {
                if (after.ItemId is not null && (after.ItemId != before.ItemId || after.Quality != before.Quality)) budgetConfirmed = false;
                baitUsed = before.Stack - after.Stack;
                if (baitUsed < 0 || baitUsed > attempt.MaxBait) budgetConfirmed = false;
            }
            else
            {
                var used = after.ItemId is null && before.Uses == FishingRod.maxTackleUses - 1 ? 1
                    : after.ItemId == before.ItemId && after.Quality == before.Quality && after.Stack == before.Stack && before.Uses.HasValue && after.Uses.HasValue ? after.Uses.Value - before.Uses.Value : -1;
                if (used < 0 || used > attempt.MaxWear) budgetConfirmed = false;
                wear.Add(new { attachmentIndex = before.Index, itemId = before.ItemId, uses = used, broken = after.ItemId is null });
            }
        }
        // Some native paths report a raw ID, others a qualified ID. Resolve ONLY against
        // actual newly gained inventory items, never prepend a guessed type prefix.
        var catchCandidates = gains.Where(row => row.Quality == attempt.CaughtQuality && row.Amount >= attempt.CaughtCount
            && Game1.player.Items.Any(item => item is not null && item.QualifiedItemId == row.ItemId
                && (item.QualifiedItemId == attempt.CaughtId || item.ItemId == attempt.CaughtId))).ToArray();
        var catchConfirmed = attempt.CaughtId is { Length: > 0 } && attempt.CaughtCount > 0 && catchCandidates.Length == 1;
        var noCatch = !current.SawCaught && gains.Length == 0;
        if (!budgetConfirmed || !catchConfirmed && !noCatch) { Finish("fishing_receipt_or_resource_budget_unconfirmed"); return; }
        var result = new { reason = "native_fishing_finished", controller = current.Kind, ticks = current.Ticks,
            completedWorkflow = true, nativeActionSubmitted = true, completionUncertain = false,
            outcome = catchConfirmed ? "caught" : current.SawMinigame ? "escaped" : attempt.SawWater ? "nothing_caught" : "invalid_cast",
            sawFishingMinigame = current.SawMinigame, sawNativeCatch = current.SawCaught, fishing = FishingEvidence(current),
            itemGains = gains, baitConsumed = baitUsed, tackleWear = wear, nativeIdle = true,
            before = current.Before, after = GameFacts.ControlState(),
            note = "One bounded native attempt ended in the world. Catch is confirmed only by matching actual inventory gain; an escaped/invalid attempt is not a successful catch. No automatic recast.",
        };
        job = null;
        current.Completion.TrySetResult(result);
    }
}
