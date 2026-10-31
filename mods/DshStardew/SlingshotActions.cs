using System.Text.Json;
using StardewModdingAPI;
using StardewValley;
using StardewValley.Tools;

namespace DshStardew;

/// <summary>Owned native slingshots and conserving ammunition changes; shooting is a separate lifecycle.</summary>
internal static partial class SlingshotActions
{
    private const string Build = "e2d77e0c-417e-41ec-b5ab-ab6e915ce317";
    private static bool Supported() => typeof(Game1).Assembly.ManifestModule.ModuleVersionId.ToString("D") == Build;
    private static string Hash(object value) => GameFacts.Hash(JsonSerializer.Serialize(value, LocalServer.Json));
    internal sealed record Ammo(string? ItemId, int Quality, int Stack, string? ItemKey, bool Explosive, int? BaseDamage);
    internal sealed record Attached(int ToolSlot, string ToolKey, int Index, string? ItemId, int Quality, int Stack, string? ItemKey);
    // Literal IDs and category fallback from this exact build's protected
    // canThisBeAttached. Do not invoke protected methods or infer from names.
    private static readonly HashSet<string> AmmoIds = new(StringComparer.Ordinal) {
        "(O)378", "(O)380", "(O)384", "(O)386", "(O)388", "(O)390", "(O)382", "(O)441",
    };
    private static bool Compatible(StardewValley.Object o) => o.GetType().Assembly == typeof(Game1).Assembly
        && (AmmoIds.Contains(o.QualifiedItemId) || !o.bigCraftable.Value && o.Category is -5 or -79 or -75);
    private static bool Ordinary(StardewValley.Object o) => Compatible(o) && !o.questItem.Value && o.Stack is > 0 and <= 10000;
    private static bool CaptureSupported()
    {
        if (Game1.player.Items.Count > 256) return false;
        var seen = new HashSet<Item>(System.Collections.Generic.ReferenceEqualityComparer.Instance);
        foreach (var item in Game1.player.Items.Where(i => i is not null))
        {
            if (item.GetType().Assembly != typeof(Game1).Assembly || item.Stack is < 1 or > 10000 || !seen.Add(item)) return false;
            if (item is not Tool tool) continue;
            if (tool.attachments.Length > 16) return false;
            foreach (var a in Enumerable.Range(0, tool.attachments.Length).Select(i => tool.attachments[i]).Where(i => i is not null))
                if (a.GetType().Assembly != typeof(Game1).Assembly || a.Stack is < 1 or > 10000 || !seen.Add(a)) return false;
        }
        return true;
    }
    private static Ammo Ammunition(Slingshot s)
    {
        var a = s.attachments.Length == 1 ? s.attachments[0] : null;
        return new(a?.QualifiedItemId, a?.Quality ?? 0, a?.Stack ?? 0, a is null ? null : MineActions.Key(a), a?.QualifiedItemId == "(O)441",
            a?.GetType().Assembly == typeof(Game1).Assembly ? s.GetAmmoDamage(a) : null);
    }
    private static Attached[] Attachments() => Game1.player.Items.Select((item, slot) => (item, slot)).Where(r => r.item is Tool)
        .SelectMany(r => { var t = (Tool)r.item; return Enumerable.Range(0, t.attachments.Length).Select(i => {
            var a = t.attachments[i]; return new Attached(r.slot, MineActions.Key(t), i, a?.QualifiedItemId, a?.Quality ?? 0, a?.Stack ?? 0, a is null ? null : MineActions.Key(a));
        }); }).ToArray();
    private static object Descriptor(Slingshot s, int slot)
    {
        var enchantments = R.Items(R.Get(s, "enchantments")).Take(33).ToArray();
        var native = enchantments.Length <= 32 && enchantments.All(e => e.GetType().Assembly == typeof(Game1).Assembly);
        var entries = enchantments.Take(32).Select(e => new { type = e.GetType().FullName,
            level = e.GetType().Assembly == typeof(Game1).Assembly ? R.Plain(R.Get(e, "level")) : null }).ToArray();
        var ammo = Ammunition(s); var toolKey = MineActions.Key(s);
        return new { slot, toolKey, itemId = s.QualifiedItemId, attachmentSlots = s.attachments.Length, ammo,
            nativeEnchantmentsOnly = native, enchantments = entries,
            gearDigest = Hash(new { toolKey, s.QualifiedItemId, ammo, native, entries }),
            selected = ReferenceEquals(Game1.player.CurrentTool, s),
            charge = ReferenceEquals(Game1.player.CurrentTool, s) && Game1.player.usingSlingshot ? (float?)s.GetSlingshotChargeTime() : null,
            requiredChargeSeconds = s.GetRequiredChargeTime(), canAutoFire = s.CanAutoFire() };
    }
    public static object Query(JsonElement args)
    {
        var state = MineActions.State();
        if (!Supported() || !CaptureSupported()) return new { available = false, state, reason = "unsupported_slingshot_build_inventory_or_attachment_capture" };
        var attached = Attachments();
        return new { available = true, complete = true, state, selectedSlot = Game1.player.CurrentToolIndex,
            usingSlingshot = Game1.player.usingSlingshot, usingTool = Game1.player.UsingTool,
            shooting = ShootingQuery(),
            legacyFiring = R.Get(Game1.options, "useLegacySlingshotFiring"),
            slingshots = Game1.player.Items.Select((item, slot) => (item, slot)).Where(r => r.item?.GetType() == typeof(Slingshot))
                .Select(r => Descriptor((Slingshot)r.item, r.slot)).ToArray(),
            eligibleInventoryAmmo = Game1.player.Items.Select((item, slot) => (item, slot)).Where(r => r.item is StardewValley.Object o && Ordinary(o))
                .Select(r => new { inventorySlot = r.slot, itemId = r.item!.QualifiedItemId, quality = r.item.Quality, stack = r.item.Stack,
                    itemKey = MineActions.Key(r.item), explosive = r.item.QualifiedItemId == "(O)441" }).ToArray(),
            attachments = attached, attachmentSetDigest = Hash(attached),
            note = "Complete bounded owned-tool attachment capture. Load candidates follow the inspected native IDs/categories and exclude quest/custom objects; existing native attachments can still be unloaded intact. Base damage is not final/random hit damage. The separate shot controller observes native charge/release and a projectile lifecycle; projectile removal is not a collision/hit claim." };
    }

    public static object Gear(JsonElement args)
    {
        InventoryActions.Require(Supported() && CaptureSupported() && Context.CanPlayerMove && Game1.activeClickableMenu is null
            && !Game1.player.UsingTool && !Game1.player.usingSlingshot && !Game1.eventUp && !Game1.fadeToBlack, "Ammunition changes require an idle supported native world");
        InventoryActions.Require(args.ValueKind == JsonValueKind.Object && args.EnumerateObject().All(p => new[] {
            "operation", "slingshotSlot", "expectedSlingshotItemId", "toolKey", "gearDigest", "inventoryDigest", "attachmentSetDigest",
            "inventorySlot", "sourceItemKey", "expectedItemId", "expectedQuality", "maxCount", "allowExplosive",
        }.Contains(p.Name)), "Unknown ammunition argument");
        var slot = R.Int(args, "slingshotSlot", -1, 0, Game1.player.Items.Count - 1);
        InventoryActions.Require(Game1.player.Items[slot]?.GetType() == typeof(Slingshot), "Use the actual owned native slingshot slot");
        var sling = (Slingshot)Game1.player.Items[slot]; var beforeAmmo = Ammunition(sling);
        var beforeAttached = Attachments(); var descriptor = Descriptor(sling, slot);
        InventoryActions.Require(sling.attachments.Length == 1 && R.Bool(descriptor, "nativeEnchantmentsOnly") && !sling.CanAutoFire()
            && sling.QualifiedItemId == R.Arg(args, "expectedSlingshotItemId") && MineActions.Key(sling) == R.Arg(args, "toolKey")
            && R.Text(descriptor, "gearDigest") == R.Arg(args, "gearDigest") && InventoryActions.Digest() == R.Arg(args, "inventoryDigest")
            && Hash(beforeAttached) == R.Arg(args, "attachmentSetDigest"), "Slingshot, ammo, inventory or other attachments changed");
        var operation = R.Arg(args, "operation"); InventoryActions.Require(operation is "attach" or "detach", "Use native attach or whole-stack detach");
        var inventorySlot = R.Int(args, "inventorySlot", -1, 0, Game1.player.Items.Count - 1);
        var quality = R.Int(args, "expectedQuality", -1, 0, 4); var maximum = R.Int(args, "maxCount", 0, 1, 10000);
        var id = R.Arg(args, "expectedItemId"); var old = sling.attachments[0];
        InventoryActions.Require(!args.TryGetProperty("allowExplosive", out var permission) || permission.ValueKind is JsonValueKind.True or JsonValueKind.False,
            "allowExplosive must be a boolean");
        InventoryActions.Require(inventorySlot != slot && (old is null || old.GetType().Assembly == typeof(Game1).Assembly && old.Stack is > 0 and <= 10000),
            "Ammo slot contains an unrecognized/custom or unbounded item");
        StardewValley.Object? source = null;
        if (operation == "attach")
        {
            source = Game1.player.Items[inventorySlot] as StardewValley.Object;
            InventoryActions.Require(source is not null && Ordinary(source) && source.QualifiedItemId == id && source.Quality == quality
                && source.Stack <= maximum && MineActions.Key(source) == R.Arg(args, "sourceItemKey"), "Use the exact complete bounded ammo source instance; split oversized sources first");
            InventoryActions.Require(source!.QualifiedItemId != "(O)441" || args.TryGetProperty("allowExplosive", out var explosive) && explosive.ValueKind == JsonValueKind.True,
                "Explosive ammo loading needs explicit permission");
            InventoryActions.Require(old is null || Game1.player.Items.Any(i => i is null), "Reserve a spare inventory slot for native replacement recovery");
        }
        else InventoryActions.Require(Game1.player.Items[inventorySlot] is null && old is not null && old.QualifiedItemId == id
            && old.Quality == quality && old.Stack <= maximum, "Detach needs the exact whole attached stack and an actual empty destination");
        var before = MineActions.State(); var beforeItems = InventoryActions.Counts(); var totals = AttachmentInventory.Totals();
        var location = Game1.currentLocation; var save = GameFacts.SaveId(); var day = GameFacts.DayKey();
        var sourceCount = source?.Stack ?? 0; var oldCount = old?.Stack ?? 0;
        var beforeQuery = Query(default);
        StardewValley.Object? returned = null;
        // Same ownership boundary as fishing: the real source is held outside
        // the bag during attach. Recover only still-unowned actual references;
        // never clone ammo, rewrite old stack quantities or replay the transfer.
        Game1.player.Items[inventorySlot] = null;
        try {
            returned = sling.attach(source);
            if (returned is not null && AttachmentInventory.Owned(returned)) throw new InvalidOperationException("Native ammo transfer returned an already-owned reference");
            AttachmentInventory.ReturnUnowned(returned, inventorySlot);
        }
        catch {
            AttachmentInventory.ReturnUnowned(returned, inventorySlot); AttachmentInventory.ReturnUnowned(source, inventorySlot);
            AttachmentInventory.ReturnUnowned(old, inventorySlot); throw;
        }
        var afterAmmo = Ammunition(sling); var afterAttached = Attachments(); var after = MineActions.State();
        var conserved = CaptureSupported() && AttachmentInventory.Conserved(totals);
        var otherUnchanged = beforeAttached.Where(a => a.ToolSlot != slot).SequenceEqual(afterAttached.Where(a => a.ToolSlot != slot));
        var loadedCount = operation == "attach" ? sourceCount - (ReferenceEquals(returned, source) ? returned?.Stack ?? 0 : 0) : 0;
        var detachedCount = operation == "detach" && ReferenceEquals(returned, old) ? oldCount : 0;
        var confirmed = conserved && otherUnchanged && beforeAmmo != afterAmmo
            && (returned is null || ReferenceEquals(Game1.player.Items[inventorySlot], returned))
            && ReferenceEquals(Game1.player.Items[slot], sling) && ReferenceEquals(Game1.currentLocation, location)
            && GameFacts.SaveId() == save && GameFacts.DayKey() == day && Context.CanPlayerMove && !Game1.player.UsingTool && !Game1.player.usingSlingshot
            && Game1.player.Money == (int)R.Number(before, "money") && Game1.player.health == (int)R.Number(before, "health")
            && Game1.player.Stamina == (float)R.Number(before, "energy")
            && (operation == "detach" ? afterAmmo.ItemId is null && detachedCount == beforeAmmo.Stack && ReferenceEquals(Game1.player.Items[inventorySlot], old)
                : afterAmmo.ItemId == id && afterAmmo.Quality == quality && afterAmmo.Stack > 0 && loadedCount > 0 && loadedCount <= sourceCount);
        var unchanged = conserved && beforeAmmo == afterAmmo && Hash(beforeAttached) == Hash(afterAttached)
            && InventoryActions.Digest() == R.Arg(args, "inventoryDigest");
        return new { completedWorkflow = confirmed, completionUncertain = !confirmed && !unchanged, nativeActionReturned = true,
            operation, slingshotSlot = slot, toolKey = MineActions.Key(sling), inventorySlot, conservedQuantity = conserved, loadedCount, detachedCount,
            beforeAmmo, afterAmmo, inventoryChanges = InventoryActions.Changes(beforeItems), before, after,
            beforeQuery, afterQuery = Query(default), note = "Only the observed ammo movement/merge/replacement is confirmed; no ammunition was fired or created." };
    }
}
