codeunit 50922 "Acc Cash Rounding Subscriber"
{
    [EventSubscriber(ObjectType::Codeunit, Codeunit::"Acc Invoice Core", 'OnAfterInvoiceTotal', '', false, false)]
    local procedure CashRoundOnInvoiceTotal(var Total: Decimal)
    begin
        Total := RoundToNickel(Total);
    end;

    local procedure RoundToNickel(Amount: Decimal): Decimal
    begin
        exit(Round(Amount, 0.05, '='));
    end;
}
