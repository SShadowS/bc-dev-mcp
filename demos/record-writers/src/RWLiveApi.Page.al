page 50192 "RW Live API"
{
    PageType = API;
    APIPublisher = 'sshadows';
    APIGroup = 'rwlive';
    APIVersion = 'v1.0';
    EntityName = 'rwItem';
    EntitySetName = 'rwItems';
    SourceTable = "RW Live Target";
    DelayedInsert = true;
    ODataKeyFields = Id;

    layout
    {
        area(Content)
        {
            repeater(Group)
            {
                field(id; Rec.Id) { }
                field(note; Rec.Note) { }
            }
        }
    }

    trigger OnInsertRecord(BelowxRec: Boolean): Boolean
    var
        Writer: Codeunit "RW Live Writer";
    begin
        Writer.RunAll(Rec.Id);
        exit(false);
    end;
}
