codeunit 50944 "Acc Tax Tests"
{
    Subtype = Test;

    [Test]
    procedure DanishTax()
    var
        TaxCore: Codeunit "Acc Tax Core";
    begin
        if TaxCore.TaxAmount(100, Enum::"Acc Region"::DK) <> 25 then
            Error('DK tax on 100 should be 25');
    end;

    [Test]
    procedure GermanTax()
    var
        TaxCore: Codeunit "Acc Tax Core";
    begin
        if TaxCore.TaxAmount(100, Enum::"Acc Region"::DE) <> 19 then
            Error('DE tax on 100 should be 19');
    end;

    [Test]
    procedure ExemptTax()
    var
        TaxCore: Codeunit "Acc Tax Core";
    begin
        if TaxCore.TaxAmount(100, Enum::"Acc Region"::Exempt) <> 0 then
            Error('Exempt tax should be 0');
    end;

    [Test]
    procedure DanishGross()
    var
        TaxCore: Codeunit "Acc Tax Core";
    begin
        if TaxCore.GrossAmount(80, Enum::"Acc Region"::DK) <> 100 then
            Error('DK gross of 80 should be 100');
    end;

    [Test]
    procedure GermanGrossRounds()
    var
        TaxCore: Codeunit "Acc Tax Core";
    begin
        if TaxCore.GrossAmount(10.01, Enum::"Acc Region"::DE) <> 11.91 then
            Error('DE gross of 10.01 should be 11.91');
    end;
}
