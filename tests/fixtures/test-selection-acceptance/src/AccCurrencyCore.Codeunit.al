codeunit 50929 "Acc Currency Core"
{
    procedure ExchangeRate(CurrencyCode: Code[10]): Decimal
    begin
        case CurrencyCode of
            '':
                exit(1);
            'EUR':
                exit(0.134);
            'USD':
                exit(0.145);
        end;
        Error('Unknown currency %1', CurrencyCode);
    end;
}
