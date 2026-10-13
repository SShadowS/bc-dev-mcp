codeunit 50926 "Acc Nightly Recalc"
{
    trigger OnRun()
    var
        LoyaltyCore: Codeunit "Acc Loyalty Core";
        RunState: Codeunit "Acc Run State";
    begin
        RunState.SetLastRecalcPoints(ApplyDecay(LoyaltyCore.PointsFor(2500)));
    end;

    local procedure ApplyDecay(Points: Decimal): Decimal
    begin
        exit(Points * 90 / 100);
    end;
}
