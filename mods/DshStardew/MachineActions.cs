using System.Text.Json;
using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewValley;
using StardewValley.GameData.Machines;
using StardewValley.Objects;
using SObject = StardewValley.Object;

namespace DshStardew;

/// <summary>Data-machine reads and exact native load/collect actions with observed receipts.</summary>
internal static class MachineActions
{
    private sealed record Target(SObject Machine, string LocationId, int X, int Y);
    private static object? ItemFact(Item? item) => item is null ? null : new { itemId = item.QualifiedItemId, quality = item.Quality, count = item.Stack };
    private static string State(SObject machine) => machine.heldObject.Value is null
        ? machine.readyForHarvest.Value || machine.MinutesUntilReady > 0 ? "unknown" : "idle"
        : machine.readyForHarvest.Value && machine.MinutesUntilReady <= 0 ? "ready"
        : !machine.readyForHarvest.Value && (machine.MinutesUntilReady > 0 || machine.GetMachineData()?.OnlyCompleteOvernight == true) ? "processing" : "unknown";
    private static Target Find(JsonElement args)
    {
        InventoryActions.Require(args.TryGetProperty("position", out var position) && position.ValueKind == JsonValueKind.Object, "Use a queried machine position");
        var location = R.Arg(position, "locationId"); var x = R.Int(position, "x", -1, 0, 10000); var y = R.Int(position, "y", -1, 0, 10000);
        InventoryActions.Require(location == Game1.currentLocation.NameOrUniqueName, "Machine must be in the current location");
        InventoryActions.Require(Game1.currentLocation.Objects.TryGetValue(new Vector2(x, y), out var machine), "Machine is not at the queried tile");
        return new Target(machine!, location, x, y);
    }
    private static string Contents(Target target) => GameFacts.Hash(JsonSerializer.Serialize(new {
        target.LocationId, target.X, target.Y, machineId = target.Machine.QualifiedItemId,
        held = ItemFact(target.Machine.heldObject.Value), input = ItemFact(target.Machine.lastInputItem.Value), ruleId = target.Machine.lastOutputRuleId.Value,
    }, LocalServer.Json));
    private static string Digest(Target target) => GameFacts.Hash(JsonSerializer.Serialize(new { contents = Contents(target),
        ready = target.Machine.readyForHarvest.Value, minutes = target.Machine.MinutesUntilReady }, LocalServer.Json));
    private static MachineOutputRule? OutputRule(SObject machine, MachineData data) => data.OutputRules?.FirstOrDefault(rule => rule.Id == machine.lastOutputRuleId.Value);
    private static SObject? Hopper(Target target)
    {
        // Object.AttemptAutoLoad(Farmer) in the inspected build reads exactly (x,y-1)
        // and Chest.specialChestType==3. Loading from that chest may continue asynchronously.
        if (!Game1.currentLocation.Objects.TryGetValue(new Vector2(target.X, target.Y - 1), out var above) || above is not Chest) return null;
        var kind = R.Get(above, "specialChestType") ?? throw new PreconditionRejectedException("Adjacent chest type is unavailable; auto-load cannot be ruled out");
        return Convert.ToInt32(kind) == 3 ? above : null;
    }
    private static Dictionary<string, int> Requirements(MachineData data)
    {
        var result = new Dictionary<string, int>(StringComparer.Ordinal);
        foreach (var item in data.AdditionalConsumedItems ?? new())
        {
            var id = ItemRegistry.QualifyItemId(R.Text(item, "ItemId")); var count = checked((int)R.Number(item, "RequiredCount"));
            InventoryActions.Require(!string.IsNullOrEmpty(id) && count >= 0, "Machine material requirement is unavailable");
            result[id!] = checked(result.GetValueOrDefault(id!) + count);
        }
        return result;
    }
    private static object Capture(Target target)
    {
        var machine = target.Machine; var data = machine.GetMachineData(); var output = machine.heldObject.Value;
        var recalculate = data is null ? true : OutputRule(machine, data)?.RecalculateOnCollect ?? true; var hopper = Hopper(target);
        return new { position = new { locationId = target.LocationId, x = target.X, y = target.Y }, machineItemId = machine.QualifiedItemId,
            state = State(machine), digest = Digest(target), contentsKey = Contents(target), minutesUntilReady = machine.MinutesUntilReady,
            readyForHarvest = machine.readyForHarvest.Value, output = ItemFact(output), lastInput = ItemFact(machine.lastInputItem.Value),
            recalculateOnCollect = recalculate,
            inventoryCanAcceptOutput = output is not null && (recalculate ? Game1.player.Items.Any(item => item is null) : Game1.player.couldInventoryAcceptThisItem(output)),
            dataMachine = data is not null, incubator = data?.IsIncubator,
            hopperMayReload = hopper is not null, hopperItemId = hopper?.QualifiedItemId,
            additionalMaterials = data is null ? null : Requirements(data),
            machineData = data is null ? (JsonElement?)null : JsonSerializer.SerializeToElement(data, LocalServer.Json),
            note = "Raw rule conditions are data, not pre-evaluated promises. Native load/collect decides eligibility; time is not advanced by this query.",
        };
    }
    public static object Query(JsonElement args) => new { machine = Capture(Find(args)), inventoryDigest = InventoryActions.Digest() };

    public static object Act(JsonElement args)
    {
        var target = Find(args); var machine = target.Machine; var data = machine.GetMachineData();
        InventoryActions.Require(data is not null && !data.IsIncubator && string.IsNullOrEmpty(data.InteractMethod), "This is not an ordinary data-machine load/collect workflow");
        InventoryActions.Require(R.Arg(args, "expectedMachineItemId") == machine.QualifiedItemId && R.Arg(args, "machineDigest") == Digest(target), "stale_machine: observe the machine again");
        InventoryActions.Require(R.Arg(args, "inventoryDigest") == InventoryActions.Digest(), "stale_inventory: observe inventory again");
        InventoryActions.Require(Math.Abs((int)Game1.player.Tile.X - target.X) + Math.Abs((int)Game1.player.Tile.Y - target.Y) <= 1, "Navigate adjacent to this actual machine first");
        InventoryActions.Require(Context.CanPlayerMove && Game1.activeClickableMenu is null && !Game1.eventUp && Game1.player.CanMove && !Game1.player.UsingTool, "Player must be idle in the world");
        var operation = R.Arg(args, "operation"); var before = Capture(target); var counts = InventoryActions.Counts();
        var allowed = new Dictionary<string, long>(StringComparer.Ordinal); var selectedSlot = -1;
        Item? input = null; var maxInput = 0; var recalculate = OutputRule(machine, data!)?.RecalculateOnCollect ?? true;
        var oldOutput = machine.heldObject.Value; var outputId = oldOutput?.QualifiedItemId; var outputQuality = oldOutput?.Quality; var outputCount = oldOutput?.Stack;
        if (operation == "load")
        {
            InventoryActions.Require(data!.HasInput && data.HasOutput && State(machine) == "idle", "Machine must be idle and accept an input");
            selectedSlot = R.Int(args, "inputSlot", -1, 0, Game1.player.Items.Count - 1);
            input = Game1.player.Items[selectedSlot]; maxInput = R.Int(args, "maxInputCount", 0, 1, 10000);
            InventoryActions.Require(input is SObject && !((SObject)input).bigCraftable.Value && input.QualifiedItemId == R.Arg(args, "inputItemId")
                && input.Quality == R.Int(args, "inputQuality", -1, 0, 4) && input.Stack > 0 && input.Stack <= maxInput, "Use an actual bounded input stack; split an oversized stack first");
            InventoryActions.Require(args.TryGetProperty("materialBudgets", out var budgets) && budgets.ValueKind == JsonValueKind.Array && budgets.GetArrayLength() <= 16, "Provide explicit material budgets, including an empty array if none");
            foreach (var budget in budgets.EnumerateArray())
            {
                var id = R.Arg(budget, "itemId"); var count = R.Int(budget, "maxCount", 0, 1, 10000);
                InventoryActions.Require(id.Length > 0 && !allowed.ContainsKey(id), "Material budget IDs must be unique"); allowed[id] = count;
            }
            foreach (var need in Requirements(data)) InventoryActions.Require(allowed.GetValueOrDefault(need.Key) >= need.Value
                && counts.Where(row => row.ItemId == need.Key).Sum(row => row.Amount) >= need.Value, "A native additional material is missing or exceeds the approved budget");
            allowed[input!.QualifiedItemId] = allowed.GetValueOrDefault(input.QualifiedItemId) + maxInput;
        }
        else if (operation == "collect")
        {
            InventoryActions.Require(Hopper(target) is null || args.TryGetProperty("allowHopperReload", out var allow) && allow.ValueKind == JsonValueKind.True,
                "Collecting here may consume the native hopper's contents; explicit allowHopperReload is required");
            InventoryActions.Require(State(machine) == "ready" && oldOutput is not null, "Machine output is not ready");
            InventoryActions.Require(recalculate ? Game1.player.Items.Any(item => item is null) : Game1.player.couldInventoryAcceptThisItem(oldOutput!), "Inventory cannot accept this output; unknown/recalculated outputs need a free slot");
        }
        else throw new PreconditionRejectedException("Use load or collect");
        bool native;
        if (operation == "load")
        {
            Game1.player.CurrentToolIndex = selectedSlot;
            if (!ReferenceEquals(Game1.player.CurrentItem, input)) throw new InvalidOperationException("Native input slot selection was not confirmed; no load was submitted");
            // Invoke this exact machine's native handler, not a generic action button which
            // could fall back to placing an invalid held item elsewhere in the world.
            native = machine.performObjectDropInAction(input!, false, Game1.player, false);
        }
        else native = machine.checkForAction(Game1.player, false);
        var changes = InventoryActions.Changes(counts); var after = Capture(target);
        var lost = changes.Where(change => change.Amount < 0).GroupBy(change => change.ItemId).ToDictionary(group => group.Key, group => -group.Sum(change => change.Amount));
        var gains = changes.Where(change => change.Amount > 0).ToArray();
        var budgetExceeded = lost.Any(pair => pair.Value > allowed.GetValueOrDefault(pair.Key));
        var confirmed = operation == "load"
            ? !budgetExceeded && input is not null && lost.GetValueOrDefault(input.QualifiedItemId) > 0 && machine.lastInputItem.Value?.QualifiedItemId == input.QualifiedItemId && (State(machine) is "processing" or "ready")
            : !budgetExceeded && !ReferenceEquals(oldOutput, machine.heldObject.Value) && (recalculate
                ? gains.Length > 0 : gains.Any(change => change.ItemId == outputId && change.Quality == outputQuality && change.Amount == outputCount));
        var unchanged = changes.Length == 0 && JsonSerializer.Serialize(before, LocalServer.Json) == JsonSerializer.Serialize(after, LocalServer.Json);
        return new { operation, completedWorkflow = confirmed, completionUncertain = !confirmed && !unchanged,
            reason = confirmed ? "native_machine_result_confirmed" : unchanged ? "native_machine_rejected_without_effect" : "machine_result_not_confirmed",
            nativeAccepted = native, budgetExceeded, inventoryChanges = changes, received = gains, beforeMachine = before, afterMachine = after,
            afterInventoryDigest = InventoryActions.Digest(), note = "A load confirms only that processing started. A full cycle is complete only after a later verified collect; auto-reload may start another native cycle.",
        };
    }
}
