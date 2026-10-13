codeunit 50923 "Acc Loyalty Core"
{
    procedure PointsFor(Amount: Decimal): Decimal
    var
        Points: Decimal;
    begin
        Points := Round(Amount / 10, 1, '<');
        OnAfterCalcPoints(Amount, Points);
        exit(Points);
    end;

    // The only route into "Acc Loyalty Bonus Subscriber".
    [IntegrationEvent(false, false)]
    local procedure OnAfterCalcPoints(Amount: Decimal; var Points: Decimal)
    begin
    end;
}
