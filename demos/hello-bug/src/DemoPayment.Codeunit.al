codeunit 50130 "Demo Payment Split"
{
    procedure SplitAmount(TotalAmount: Decimal; NumberOfPayments: Integer) PerPayment: Decimal
    var
        CustomerName: Text[100];
        Remainder: Decimal;
    begin
        CustomerName := 'Kontorcentralen A/S';
        Remainder := TotalAmount;
        PerPayment := TotalAmount / NumberOfPayments; // runtime error when NumberOfPayments = 0
        Remainder := TotalAmount - PerPayment * NumberOfPayments;
    end;
}
