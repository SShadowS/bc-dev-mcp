codeunit 50924 "Acc Loyalty Bonus Subscriber"
{
    [EventSubscriber(ObjectType::Codeunit, Codeunit::"Acc Loyalty Core", 'OnAfterCalcPoints', '', false, false)]
    local procedure AddBonusOnCalcPoints(Amount: Decimal; var Points: Decimal)
    begin
        if Amount >= 1000 then
            Points += BonusPoints();
    end;

    local procedure BonusPoints(): Decimal
    begin
        exit(50);
    end;
}
