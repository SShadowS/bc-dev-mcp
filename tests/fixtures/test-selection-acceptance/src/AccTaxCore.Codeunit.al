codeunit 50913 "Acc Tax Core"
{
    var
        Math: Codeunit "Acc Math";

    // The only route into the three "Acc Tax Rate" implementations is this interface dispatch.
    procedure TaxAmount(Amount: Decimal; Region: Enum "Acc Region"): Decimal
    var
        TaxRate: Interface "Acc Tax Rate";
    begin
        TaxRate := Region;
        exit(Math.Percent(Amount, TaxRate.RatePct()));
    end;

    procedure GrossAmount(Amount: Decimal; Region: Enum "Acc Region"): Decimal
    begin
        exit(Amount + TaxAmount(Amount, Region));
    end;
}
