codeunit 50946 "Acc Invoice Tests"
{
    Subtype = Test;

    [Test]
    procedure InvoiceBoltRating2Danish()
    var
        Core: Codeunit "Acc Invoice Core";
    begin
        if Core.InvoiceTotal('BOLT', 10, 2, Enum::"Acc Region"::DK) <> 32.05 then
            Error('Invoice for 10 BOLT, rating 2, DK should be 32.05');
    end;

    [Test]
    procedure InvoiceGearExempt()
    var
        Core: Codeunit "Acc Invoice Core";
    begin
        if Core.InvoiceTotal('GEAR', 1, 5, Enum::"Acc Region"::Exempt) <> 50 then
            Error('Invoice for 1 GEAR, exempt should be 50');
    end;

    [Test]
    procedure InvoiceWithStandardShipping()
    var
        Rules: Codeunit "Acc Invoice Rules";
    begin
        if Rules.InvoiceWithShipping('GEAR', 2, 5, Enum::"Acc Region"::Exempt, false) <> 110 then
            Error('2 GEAR with standard shipping should be 110');
    end;

    [Test]
    procedure InvoiceFreeShipping()
    var
        Rules: Codeunit "Acc Invoice Rules";
    begin
        if Rules.InvoiceWithShipping('GEAR', 12, 5, Enum::"Acc Region"::Exempt, false) <> 570 then
            Error('12 GEAR ship free at 570');
    end;

    [Test]
    procedure InvoiceInEuro()
    var
        Core: Codeunit "Acc Invoice Core";
        Rules: Codeunit "Acc Invoice Rules";
    begin
        if Rules.ConvertTotal(Core.InvoiceTotal('GEAR', 1, 5, Enum::"Acc Region"::Exempt), 'EUR') <> 6.7 then
            Error('50 in EUR should be 6.70');
    end;
}
