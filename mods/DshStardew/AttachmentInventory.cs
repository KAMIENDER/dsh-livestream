using System.Text.Json;
using StardewValley;

namespace DshStardew;

/// <summary>Shared native attachment ownership and conservation, extracted from fishing gear.</summary>
internal static class AttachmentInventory
{
    internal sealed record Total(string ItemId, int Quality, long Amount);
    internal static Total[] Totals()
    {
        var items = Game1.player.Items.Where(item => item is not null).ToList();
        foreach (var tool in Game1.player.Items.OfType<Tool>())
            for (var i = 0; i < tool.attachments.Length; i++) if (tool.attachments[i] is { } attached) items.Add(attached);
        return items.GroupBy(item => (item.QualifiedItemId, item.Quality)).Select(group => new Total(group.Key.QualifiedItemId, group.Key.Quality, group.Sum(item => (long)item.Stack)))
            .OrderBy(total => total.ItemId, StringComparer.Ordinal).ThenBy(total => total.Quality).ToArray();
    }
    internal static bool Conserved(Total[] before) => JsonSerializer.Serialize(before, LocalServer.Json) == JsonSerializer.Serialize(Totals(), LocalServer.Json);
    internal static bool Owned(Item candidate) => Game1.player.Items.Any(item => ReferenceEquals(item, candidate))
        || Game1.player.Items.OfType<Tool>().Any(tool => Enumerable.Range(0, tool.attachments.Length).Any(index => ReferenceEquals(tool.attachments[index], candidate)));
    internal static void ReturnUnowned(Item? item, int preferredSlot)
    {
        if (item is null || item.Stack <= 0 || Owned(item)) return;
        var slot = Game1.player.Items[preferredSlot] is null ? preferredSlot : Enumerable.Range(0, Game1.player.Items.Count).Where(index => Game1.player.Items[index] is null).DefaultIfEmpty(-1).First();
        if (slot < 0) throw new InvalidOperationException("Native attachment transfer has an unowned item and no reserved recovery slot");
        Game1.player.Items[slot] = item;
    }
}
