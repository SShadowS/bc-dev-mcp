codeunit 50981 "Sel Surcharge Subscriber"
{
    [EventSubscriber(ObjectType::Codeunit, Codeunit::"Sel Pricing", 'OnAfterFinalizeAmount', '', false, false)]
    local procedure AddSurchargeOnFinalize(var Amount: Decimal)
    begin
        Amount += SurchargeFor(Amount);
    end;

    local procedure SurchargeFor(Amount: Decimal): Decimal
    begin
        if Amount < 100 then
            exit(5);
        exit(0);
    end;
}
