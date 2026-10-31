using StardewModdingAPI;
using StardewModdingAPI.Events;

namespace DshStardew;

public sealed class ModEntry : Mod
{
    private LocalServer? server;
    public override void Entry(IModHelper helper)
    {
        var config = helper.ReadConfig<LocalConfig>();
        helper.WriteConfig(config);
        try { server = new LocalServer(config, helper); }
        catch (Exception error) { Monitor.Log($"Local extension could not start ({error.GetType().Name}). Check port availability and config.", LogLevel.Error); return; }
        helper.Events.GameLoop.UpdateTicking += OnTick;
        helper.Events.GameLoop.DayEnding += (_, _) => server.DayEnding();
        helper.Events.GameLoop.DayStarted += (_, _) => server.DayStarted();
        helper.Events.Display.MenuChanged += (_, e) => server.MenuChanged(e.NewMenu);
        helper.Events.GameLoop.ReturnedToTitle += (_, _) => server.Reset("returned_to_title");
        helper.Events.Input.ButtonPressed += (_, e) => { if (e.Button == SButton.F9) server.Reset("manual_emergency_stop"); };
        Monitor.Log("DSH extension is listening on loopback. F9 releases its controller. New gameplay code has not been playtested.", LogLevel.Info);
    }

    private void OnTick(object? sender, UpdateTickingEventArgs e) => server?.Tick();
}
