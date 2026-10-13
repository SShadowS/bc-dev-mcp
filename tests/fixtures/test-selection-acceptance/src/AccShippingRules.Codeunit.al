codeunit 50918 "Acc Shipping Rules"
{
    var
        Core: Codeunit "Acc Shipping Core";
        Validation: Codeunit "Acc Shipping Validation";

    procedure FreeShippingThreshold(): Decimal
    begin
        exit(500);
    end;

    procedure ShippingCharge(OrderAmount: Decimal; Weight: Decimal; Express: Boolean): Decimal
    begin
        Validation.ValidateWeight(Weight);
        if (not Express) and (OrderAmount >= FreeShippingThreshold()) then
            exit(0);
        exit(Core.Freight(Weight, Express));
    end;
}
