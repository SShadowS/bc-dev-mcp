codeunit 50920 "Acc Invoice Core"
{
    var
        ItemRules: Codeunit "Acc Item Rules";
        PriceRules: Codeunit "Acc Price Rules";
        DiscountRules: Codeunit "Acc Discount Rules";
        TaxCore: Codeunit "Acc Tax Core";

    procedure InvoiceTotal(ItemNo: Code[20]; Quantity: Decimal; Rating: Integer; Region: Enum "Acc Region"): Decimal
    var
        Total: Decimal;
    begin
        Total := PriceRules.NetLineAmount(Quantity, ItemRules.SalesPrice(ItemNo));
        Total := DiscountRules.CustomerPrice(Total, Rating);
        Total := TaxCore.GrossAmount(Total, Region);
        OnAfterInvoiceTotal(Total);
        exit(Total);
    end;

    // The only route into "Acc Cash Rounding Subscriber".
    [IntegrationEvent(false, false)]
    local procedure OnAfterInvoiceTotal(var Total: Decimal)
    begin
    end;
}
