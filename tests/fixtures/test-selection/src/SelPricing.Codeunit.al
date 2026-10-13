codeunit 50980 "Sel Pricing"
{
    procedure CalcLineAmount(Quantity: Decimal; UnitPrice: Decimal): Decimal
    begin
        exit(RoundAmount(Quantity * UnitPrice));
    end;

    procedure ApplyDiscount(Amount: Decimal; DiscountPct: Decimal): Decimal
    begin
        if (DiscountPct < 0) or (DiscountPct > 100) then
            Error('Discount %1 is out of range', DiscountPct);
        exit(RoundAmount(Amount * (100 - DiscountPct) / 100));
    end;

    procedure RoundAmount(Amount: Decimal): Decimal
    begin
        exit(Round(Amount, 0.01, '='));
    end;

    // The only route into "Sel Surcharge Subscriber" is the integration event raised here.
    procedure FinalizeAmount(Amount: Decimal): Decimal
    begin
        OnAfterFinalizeAmount(Amount);
        exit(RoundAmount(Amount));
    end;

    // The only route into "Sel Express Rate" is this interface dispatch.
    procedure ShippingCost(Carrier: Enum "Sel Carrier"; Weight: Decimal): Decimal
    var
        ShippingRate: Interface "Sel Shipping Rate";
    begin
        ShippingRate := Carrier;
        exit(RoundAmount(ShippingRate.Rate(Weight)));
    end;

    // Deliberately reached by no test: the "uncoverable" changed procedure.
    procedure LegacyTaxAmount(Amount: Decimal): Decimal
    begin
        exit(RoundAmount(Amount * 0.25));
    end;

    [IntegrationEvent(false, false)]
    local procedure OnAfterFinalizeAmount(var Amount: Decimal)
    begin
    end;
}
