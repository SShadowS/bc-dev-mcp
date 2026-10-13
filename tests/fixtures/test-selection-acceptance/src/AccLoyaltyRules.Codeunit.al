codeunit 50925 "Acc Loyalty Rules"
{
    var
        RunState: Codeunit "Acc Run State";

    procedure Tier(Points: Decimal): Text
    begin
        if Points >= 500 then
            exit('Gold');
        if Points >= 100 then
            exit('Silver');
        exit('Bronze');
    end;

    // The only route into "Acc Nightly Recalc" is Codeunit.Run (a Run edge to its OnRun trigger).
    procedure RecalcNightly(): Decimal
    begin
        Codeunit.Run(Codeunit::"Acc Nightly Recalc");
        exit(RunState.GetLastRecalcPoints());
    end;
}
