codeunit 50921 "Acc Invoice Rules"
{
    var
        Core: Codeunit "Acc Invoice Core";
        ItemCore: Codeunit "Acc Item Core";
        ShippingRules: Codeunit "Acc Shipping Rules";
        CurrencyRules: Codeunit "Acc Currency Rules";

    procedure InvoiceWithShipping(ItemNo: Code[20]; Quantity: Decimal; Rating: Integer; Region: Enum "Acc Region"; Express: Boolean): Decimal
    var
        Total: Decimal;
    begin
        Total := Core.InvoiceTotal(ItemNo, Quantity, Rating, Region);
        exit(Total + ShippingRules.ShippingCharge(Total, ItemCore.Weight(ItemNo) * Quantity, Express));
    end;

    procedure ConvertTotal(Total: Decimal; CurrencyCode: Code[10]): Decimal
    begin
        exit(CurrencyRules.Convert(Total, CurrencyCode));
    end;
}
